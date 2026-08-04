import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { customAlphabet } from "nanoid";
import QRCode from "qrcode";
import {
  checkDb,
  closeDb,
  getDataStoreState,
  getDbPath,
  initializeDataStore,
  reconnectPostgres,
  recordPowerToolLog,
  readDb,
  writeDb
} from "./dataStore.js";
import {
  hashPassword,
  upgradePasswordHash,
  verifyPassword
} from "./passwords.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 5057);
const nanoid = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", 8);
const POSTGRES_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.POSTGRES_ENABLED || "").trim()
);
const DATABASE_RETRY_INTERVAL_MS = Math.min(
  300000,
  Math.max(5000, Number(process.env.POSTGRES_RETRY_INTERVAL_MS || 15000) || 15000)
);

const TOOL_TYPE_IDS = ["cat-elc", "cat-portable-tool"];
const QUESTION_TYPES = new Set(["text", "number", "date", "textarea", "radio", "checkboxes", "select", "yesno", "image"]);
const OPTION_QUESTION_TYPES = new Set(["radio", "checkboxes", "select"]);
const AUTO_DECISION_QUESTION_TYPES = new Set(["radio", "select", "yesno"]);
const trustProxy = Number(process.env.TRUST_PROXY || 1);
app.set("trust proxy", Number.isInteger(trustProxy) && trustProxy >= 0 ? trustProxy : 1);
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const databaseState = {
  ready: false,
  connecting: false,
  lastConnectedAt: "",
  lastError: ""
};
let databaseConnectionPromise;
let databaseRetryTimer;
let databaseMonitorTimer;
let shuttingDown = false;

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function publicDatabaseState() {
  const store = getDataStoreState();
  return {
    ok: databaseState.ready,
    provider: store.provider,
    configuredProvider: store.configuredProvider,
    status: !databaseState.ready
      ? "initializing"
      : store.provider === "postgresql"
        ? "connected"
        : store.fallback
          ? "local-fallback"
          : "connected",
    ...(POSTGRES_ENABLED ? { schema: normalizeText(process.env.POSTGRES_SCHEMA || "app") || "app" } : {}),
    fallback: store.fallback,
    retrying: POSTGRES_ENABLED && store.provider !== "postgresql",
    retryIntervalMs: POSTGRES_ENABLED ? DATABASE_RETRY_INTERVAL_MS : undefined,
    lastConnectedAt: store.lastPostgresConnectedAt || databaseState.lastConnectedAt || null
  };
}

function isDatabaseConnectionError(error) {
  if (!POSTGRES_ENABLED || !error) return false;
  const code = normalizeText(error.code || error.cause?.code).toUpperCase();
  const message = normalizeText(error.message).toLowerCase();
  return code.startsWith("08")
    || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "57P01", "57P02", "57P03"].includes(code)
    || message.includes("connection terminated")
    || message.includes("connection timeout")
    || message.includes("connect econnrefused")
    || message.includes("client has already been released")
    || message.includes("cannot use a pool after calling end");
}

function scheduleDatabaseRetry(delay = DATABASE_RETRY_INTERVAL_MS) {
  if (!POSTGRES_ENABLED || shuttingDown || databaseRetryTimer) return;
  if (getDataStoreState().provider === "postgresql") return;
  databaseRetryTimer = setTimeout(() => {
    databaseRetryTimer = undefined;
    attemptPostgresReconnect().catch(() => {});
  }, delay);
  databaseRetryTimer.unref?.();
}

function startDatabaseMonitor() {
  if (!POSTGRES_ENABLED || databaseMonitorTimer) return;
  databaseMonitorTimer = setInterval(() => {
    if (shuttingDown || databaseState.connecting) return;
    if (getDataStoreState().provider !== "postgresql") {
      attemptPostgresReconnect().catch(() => {});
      return;
    }
    checkDb()
      .then((result) => {
        if (result.provider !== "postgresql") scheduleDatabaseRetry(0);
      })
      .catch((error) => markDatabaseUnavailable(error));
  }, DATABASE_RETRY_INTERVAL_MS);
  databaseMonitorTimer.unref?.();
}

function markDatabaseUnavailable(error) {
  const message = normalizeText(error?.message) || "Unknown database connection error";
  const shouldLog = databaseState.lastError !== message;
  databaseState.lastError = message;
  if (shouldLog) {
    console.warn(`[Database] PostgreSQL unavailable: ${message}. Using the local fallback and retrying in ${DATABASE_RETRY_INTERVAL_MS}ms.`);
  }
  scheduleDatabaseRetry();
}

async function attemptPostgresReconnect() {
  if (!POSTGRES_ENABLED || shuttingDown || databaseState.connecting) return;
  databaseState.connecting = true;
  try {
    const state = await reconnectPostgres();
    databaseState.lastConnectedAt = state.lastPostgresConnectedAt || nowIso();
    databaseState.lastError = "";
  } catch (error) {
    markDatabaseUnavailable(error);
  } finally {
    databaseState.connecting = false;
  }
}

async function connectDataStore() {
  if (databaseConnectionPromise) return databaseConnectionPromise;
  databaseConnectionPromise = (async () => {
    await initializeDataStore();
    let db = await readDb();
    if (syncConfiguredAdmin(db)) db = await writeDb(db);
    const usage = ensureUsage(db);

    databaseState.ready = true;
    databaseState.lastError = "";

    console.log(`[Database] Active store: ${getDbPath()}`);
    logUsage(usage, "stored totals");
    logUsageByIp(usage);
    if (POSTGRES_ENABLED) scheduleDatabaseRetry(0);
  })()
    .catch((error) => {
      databaseState.lastError = normalizeText(error?.message) || "Local data store initialization failed.";
      console.error(`[Database] Local fallback failed: ${databaseState.lastError}`);
      throw error;
    })
    .finally(() => {
      databaseConnectionPromise = undefined;
    });

  return databaseConnectionPromise;
}

function hasAnswer(value) {
  if (Array.isArray(value)) return value.some((entry) => normalizeText(entry));
  return Boolean(normalizeText(value));
}

function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "field";
}

function getPublicBaseUrl(req) {
  const configured = normalizeText(process.env.PUBLIC_APP_URL);
  if (configured) return configured.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`.replace(/\/$/, "");
}

function makeItemUrl(req, qrId) {
  return `${getPublicBaseUrl(req)}/item/${encodeURIComponent(qrId)}`;
}

function getQrPayload(req, qrId) {
  const mode = normalizeText(process.env.QR_PAYLOAD_MODE || "url").toLowerCase();
  if (["code", "id", "qr-id", "qr_id"].includes(mode)) {
    return `POWERTOOL:${qrId}`;
  }
  return makeItemUrl(req, qrId);
}

function makeBrandedQrSvg(rawSvg) {
  const badge = `
  <rect x="208" y="208" width="144" height="144" rx="28" fill="#ffffff" stroke="#0f62fe" stroke-width="6"/>
  <circle cx="280" cy="280" r="50" fill="#0f62fe"/>
  <text x="280" y="276" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="900" fill="#ffffff">U</text>
  <text x="280" y="303" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="800" fill="#ffffff">POWER TOOL</text>`;
  return rawSvg.replace("</svg>", `${badge}\n</svg>`);
}

async function createBrandedQrDataUrl(payload) {
  const rawSvg = await QRCode.toString(payload, {
    type: "svg",
    errorCorrectionLevel: "H",
    margin: 2,
    width: 560,
    color: {
      dark: "#122033",
      light: "#ffffff"
    }
  });
  const brandedSvg = makeBrandedQrSvg(rawSvg);
  return `data:image/svg+xml;base64,${Buffer.from(brandedSvg).toString("base64")}`;
}

async function ensureBrandedQrForItem(req, item) {
  const expectedPayload = getQrPayload(req, item.qrId);
  if (item.qrBrand === "power-tool-v2" && item.qrImageDataUrl && item.qrPayload === expectedPayload) return false;
  item.qrPayload = expectedPayload;
  item.qrImageDataUrl = await createBrandedQrDataUrl(item.qrPayload);
  item.qrBrand = "power-tool-v2";
  item.updatedAt = nowIso();
  return true;
}

function getItemValidity(item) {
  const archived = Boolean(item.archivedAt);
  const expiresAt = item.expiresAt ? new Date(item.expiresAt) : null;
  const invalidDate = !expiresAt || Number.isNaN(expiresAt.getTime());
  const expired = invalidDate || expiresAt.getTime() < Date.now();
  const daysLeft = invalidDate
    ? null
    : Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  return {
    status: archived ? "archived" : expired ? "expired" : "valid",
    isExpired: expired,
    isArchived: archived,
    daysLeft
  };
}

function validateImageDataUrl(value) {
  const image = normalizeText(value);
  if (!image) return { value: "" };
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(image)) {
    return { error: "Tool image must be a valid image upload." };
  }
  if (image.length > 12_000_000) {
    return { error: "Tool image is too large. Please upload a smaller image." };
  }
  return { value: image };
}

function validateImageList(values, legacyImage = "") {
  const rawImages = Array.isArray(values)
    ? values
    : (legacyImage ? [legacyImage] : []);
  if (rawImages.length > 8) {
    return { error: "You can upload up to 8 equipment images." };
  }

  const images = [];
  let totalLength = 0;
  for (const rawImage of rawImages) {
    const result = validateImageDataUrl(rawImage);
    if (result.error) return result;
    if (!result.value) continue;
    totalLength += result.value.length;
    if (totalLength > 18_000_000) {
      return { error: "The equipment images are too large. Please use smaller images." };
    }
    images.push(result.value);
  }
  return { value: images };
}

function normalizeIp(req) {
  const forwarded = normalizeText(req.headers["x-forwarded-for"]).split(",")[0].trim();
  return (forwarded || normalizeText(req.socket?.remoteAddress) || "unknown").replace(/^::ffff:/, "");
}

function usageLogContext(req) {
  return {
    ipAddress: normalizeIp(req),
    requestMethod: req.method,
    responseStatus: 200,
    userAgent: normalizeText(req.get("user-agent")).slice(0, 1000)
  };
}

function clientProfile(req) {
  const userAgent = normalizeText(req.get("user-agent"));
  let browser = "Unknown";
  let operatingSystem = "Unknown";
  let deviceType = "Desktop";

  if (/Edg\//i.test(userAgent)) browser = "Microsoft Edge";
  else if (/OPR\//i.test(userAgent)) browser = "Opera";
  else if (/CriOS\//i.test(userAgent)) browser = "Google Chrome";
  else if (/Chrome\//i.test(userAgent)) browser = "Google Chrome";
  else if (/FxiOS\//i.test(userAgent)) browser = "Mozilla Firefox";
  else if (/Firefox\//i.test(userAgent)) browser = "Mozilla Firefox";
  else if (/Safari\//i.test(userAgent)) browser = "Safari";

  if (/Windows/i.test(userAgent)) operatingSystem = "Windows";
  else if (/Android/i.test(userAgent)) operatingSystem = "Android";
  else if (/iPhone|iPad|iPod/i.test(userAgent)) operatingSystem = "iOS / iPadOS";
  else if (/Mac OS X/i.test(userAgent)) operatingSystem = "macOS";
  else if (/Linux/i.test(userAgent)) operatingSystem = "Linux";

  if (/iPad|Tablet/i.test(userAgent) || (/Android/i.test(userAgent) && !/Mobile/i.test(userAgent))) {
    deviceType = "Tablet";
  } else if (/Mobile|iPhone|iPod|Android/i.test(userAgent)) {
    deviceType = "Mobile";
  }

  return { browser, operatingSystem, deviceType };
}

function ensureUsage(db) {
  db.usage = db.usage && typeof db.usage === "object" ? db.usage : {};
  db.usage.totalVisits = Number(db.usage.totalVisits || 0);
  db.usage.totalQrOpens = Number(db.usage.totalQrOpens || 0);
  db.usage.totalChecklistViews = Number(db.usage.totalChecklistViews || 0);
  db.usage.ips = db.usage.ips && typeof db.usage.ips === "object" ? db.usage.ips : {};
  db.usage.sessions = db.usage.sessions && typeof db.usage.sessions === "object" ? db.usage.sessions : {};
  db.usage.events = db.usage.events && typeof db.usage.events === "object" ? db.usage.events : {};
  return db.usage;
}

function usageIpRecord(usage, ip) {
  if (!usage.ips[ip]) {
    usage.ips[ip] = {
      ip,
      visits: 0,
      qrOpens: 0,
      checklistViews: 0,
      firstSeenAt: nowIso(),
      lastSeenAt: nowIso(),
      lastPath: ""
    };
  }
  return usage.ips[ip];
}

function sessionAccountFromPayload(db, payload = {}) {
  const username = normalizeText(payload.accountUsername).toLowerCase();
  const role = normalizeText(payload.accountRole).toLowerCase();
  if (!username || !["reviewer", "admin"].includes(role)) return null;
  return (db.staffAccounts || []).find((entry) =>
    normalizeText(entry.username).toLowerCase() === username
    && normalizeText(entry.role).toLowerCase() === role
    && entry.active !== false
  ) || null;
}

function touchVisitorSession(db, req, options = {}) {
  const usage = ensureUsage(db);
  const sessionId = normalizeText(options.sessionId).slice(0, 120);
  if (!sessionId) return null;

  const timestamp = nowIso();
  const ip = normalizeIp(req);
  const pathName = normalizeText(options.path).slice(0, 240);
  const profile = clientProfile(req);
  const existingSession = usage.sessions[sessionId];
  const ipRecord = usageIpRecord(usage, ip);
  const session = existingSession || {
    sessionId,
    ip,
    createdAt: timestamp,
    firstPath: pathName,
    visitorType: "visitor",
    accountUsername: "",
    accountDisplayName: "",
    authenticated: false,
    loginCount: 0,
    loggedInAt: "",
    loggedOutAt: "",
    endedAt: ""
  };

  if (!existingSession) {
    usage.totalVisits += 1;
    ipRecord.visits += 1;
    usage.sessions[sessionId] = session;
  }

  session.ip = ip;
  session.path = pathName || session.path || "";
  session.firstPath = session.firstPath || session.path;
  session.lastSeenAt = timestamp;
  session.browser = profile.browser;
  session.operatingSystem = profile.operatingSystem;
  session.deviceType = profile.deviceType;
  ipRecord.lastSeenAt = timestamp;
  ipRecord.lastPath = session.path;

  if (options.account) {
    const accountUsername = normalizeText(options.account.username);
    const isSameAuthenticatedAccount = Boolean(
      session.authenticated
      && normalizeText(session.accountUsername).toLowerCase() === accountUsername.toLowerCase()
    );
    session.visitorType = normalizeText(options.account.role).toLowerCase() || "visitor";
    session.accountUsername = accountUsername;
    session.accountDisplayName = options.account.displayName || accountUsername;
    session.authenticated = true;
    session.loggedOutAt = "";
    if (!isSameAuthenticatedAccount) {
      session.loggedInAt = timestamp;
      session.loginCount = Number(session.loginCount || 0) + 1;
    }
  }

  if (options.markLogout) {
    session.authenticated = false;
    session.loggedOutAt = timestamp;
  }

  if (options.markEnded) {
    session.status = "ended";
    session.endedAt = timestamp;
  } else {
    session.status = "active";
    session.endedAt = "";
  }

  trimUsageHistory(usage, "sessions");
  return { usage, session, ipRecord, isNew: !existingSession };
}

function visitorSessionDetails(session) {
  return {
    visitorType: session.visitorType || "visitor",
    accountUsername: session.accountUsername || "",
    accountDisplayName: session.accountDisplayName || "",
    authenticated: Boolean(session.authenticated),
    loginCount: Number(session.loginCount || 0),
    loggedInAt: session.loggedInAt || "",
    loggedOutAt: session.loggedOutAt || "",
    sessionStatus: session.status || "active",
    sessionEndedAt: session.endedAt || "",
    firstPath: session.firstPath || "",
    deviceType: session.deviceType || "Desktop",
    browser: session.browser || "Unknown",
    operatingSystem: session.operatingSystem || "Unknown"
  };
}

async function persistVisitorSession(req, session) {
  return recordPowerToolLog({
    eventType: "visitor_session",
    eventKey: session.sessionId,
    sessionId: session.sessionId,
    requestPath: session.path,
    ...usageLogContext(req),
    details: visitorSessionDetails(session)
  });
}

function trimUsageHistory(usage, key, limit = 5000) {
  const entries = Object.entries(usage[key] || {});
  if (entries.length <= limit) return;
  entries
    .sort((a, b) => new Date(b[1]?.lastSeenAt || b[1]?.createdAt || 0) - new Date(a[1]?.lastSeenAt || a[1]?.createdAt || 0))
    .slice(limit)
    .forEach(([entryKey]) => delete usage[key][entryKey]);
}

function logUsage(usage, message) {
  const uniqueIps = Object.keys(usage.ips || {}).length;
  console.log(
    `[Usage] ${message} | visits=${usage.totalVisits} uniqueIps=${uniqueIps} qrOpens=${usage.totalQrOpens} checklistViews=${usage.totalChecklistViews}`
  );
}

function logUsageByIp(usage) {
  const records = Object.values(usage.ips || {})
    .sort((a, b) => Number(b.visits || 0) - Number(a.visits || 0))
    .slice(0, 50);
  if (records.length === 0) {
    console.log("[Usage][IP] No application visits recorded yet.");
    return;
  }
  for (const record of records) {
    console.log(
      `[Usage][IP] ${record.ip} | visits=${Number(record.visits || 0)} qrOpens=${Number(record.qrOpens || 0)} checklistViews=${Number(record.checklistViews || 0)} lastSeen=${record.lastSeenAt || "—"}`
    );
  }
}

function publicStaffAccount(account) {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName || account.username,
    role: normalizeText(account.role).toLowerCase(),
    active: account.active !== false,
    createdAt: account.createdAt || ""
  };
}

function syncConfiguredAdmin(db) {
  const username = normalizeText(process.env.ADMIN_USERNAME || "admin").toLowerCase();
  const password = normalizeText(process.env.ADMIN_PASSWORD);
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    throw new Error("ADMIN_USERNAME must be 3–40 characters using letters, numbers, dots, dashes, or underscores.");
  }
  if (password.length < 12) {
    throw new Error("ADMIN_PASSWORD must be set in .env and contain at least 12 characters.");
  }

  db.staffAccounts = Array.isArray(db.staffAccounts) ? db.staffAccounts : [];
  let account = db.staffAccounts.find((entry) =>
    normalizeText(entry.role).toLowerCase() === "admin"
  );
  let changed = false;

  if (!account) {
    account = {
      id: "admin",
      username,
      password: hashPassword(password),
      role: "admin",
      displayName: username,
      active: true,
      createdAt: nowIso()
    };
    db.staffAccounts.unshift(account);
    return true;
  }

  if (account.username !== username || account.displayName !== username || account.active === false) {
    account.username = username;
    account.displayName = username;
    account.active = true;
    changed = true;
  }
  if (!verifyPassword(password, account.password)) {
    account.password = hashPassword(password);
    changed = true;
  } else if (upgradePasswordHash(account, password)) {
    changed = true;
  }
  return changed;
}

function isAdminActor(db, username, password) {
  const finalUsername = normalizeText(username).toLowerCase();
  const account = (db.staffAccounts || []).find((entry) =>
    normalizeText(entry.username).toLowerCase() === finalUsername
    && normalizeText(entry.role).toLowerCase() === "admin"
    && entry.active !== false
  );
  if (!account) return false;
  if (password === undefined) return true;
  const verified = verifyPassword(normalizeText(password), account.password);
  if (verified) upgradePasswordHash(account, normalizeText(password));
  return verified;
}

function publicReviewerAccount(account) {
  return {
    ...publicStaffAccount(account),
    role: "reviewer"
  };
}

function sortStaffAccounts(accounts) {
  return [...accounts].sort((a, b) => {
    if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
    return a.username.localeCompare(b.username);
  });
}

function ensureRequestWorkflow(request) {
  let changed = false;
  if (!Array.isArray(request.approvalFlow) || request.approvalFlow.join("|") !== "reviewer|admin") {
    request.approvalFlow = ["reviewer", "admin"];
    changed = true;
  }
  if (!Array.isArray(request.approvals)) {
    request.approvals = [];
    changed = true;
  }

  if (request.status === "pending") {
    if (request.currentApprovalRole !== "reviewer-or-admin") {
      request.currentApprovalRole = "reviewer-or-admin";
      changed = true;
    }
  } else if (request.currentApprovalRole) {
    request.currentApprovalRole = "";
    changed = true;
  }

  return changed;
}

function requestCanBeActionedBy(request, role) {
  return request.status === "pending" && ["reviewer", "admin"].includes(normalizeText(role).toLowerCase());
}

function questionAnswerOptions(type, options) {
  if (type === "yesno") return ["Yes", "No"];
  if (["radio", "select"].includes(type)) return options;
  return [];
}

function normalizeAutomaticDecision(field, type, options, label) {
  const enabled = Boolean(field.autoDecision?.enabled);
  if (!enabled) return { value: { enabled: false, outcomes: {} } };
  if (!AUTO_DECISION_QUESTION_TYPES.has(type)) {
    return { error: `${label} must use Yes / No, Multiple choice, or Dropdown for an automatic decision.` };
  }

  const answers = questionAnswerOptions(type, options);
  const submittedOutcomes = field.autoDecision?.outcomes && typeof field.autoDecision.outcomes === "object"
    ? field.autoDecision.outcomes
    : {};
  const outcomes = {};
  for (const answer of answers) {
    const outcome = normalizeText(submittedOutcomes[answer]).toLowerCase();
    if (!["approved", "rejected"].includes(outcome)) {
      return { error: `${label}: ${answer} must be mapped to Auto approve or Auto reject.` };
    }
    outcomes[answer] = outcome;
  }
  const uniqueOutcomes = new Set(Object.values(outcomes));
  if (!uniqueOutcomes.has("approved") || !uniqueOutcomes.has("rejected")) {
    return { error: `${label} must include both an approval and rejection result.` };
  }
  return { value: { enabled: true, outcomes } };
}

function normalizeFields(fields, labelName, allowAutomaticDecision = false) {
  const normalizedFields = [];
  const usedIds = new Set();

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const label = normalizeText(field.label);
    if (!label) return { error: `${labelName} ${index + 1} needs a title.` };
    const type = QUESTION_TYPES.has(field.type) ? field.type : "text";
    const options = OPTION_QUESTION_TYPES.has(type)
      ? (Array.isArray(field.options) ? field.options : String(field.options || "").split("\n"))
          .map(normalizeText)
          .filter(Boolean)
      : [];
    if (OPTION_QUESTION_TYPES.has(type) && options.length === 0) {
      return { error: `${label} needs at least one answer option.` };
    }
    const automaticDecision = allowAutomaticDecision
      ? normalizeAutomaticDecision(field, type, options, label)
      : { value: { enabled: false, outcomes: {} } };
    if (automaticDecision.error) return automaticDecision;

    let id = normalizeText(field.id) || `field-${slugify(label)}-${index + 1}`;
    if (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);
    normalizedFields.push({
      id,
      label,
      type,
      required: automaticDecision.value.enabled ? true : Boolean(field.required),
      placeholder: normalizeText(field.placeholder),
      options,
      autoDecision: automaticDecision.value
    });
  }

  return { fields: normalizedFields };
}

function validateCategoryPayload(body, existingId) {
  if (!TOOL_TYPE_IDS.includes(existingId)) return { error: "Only ELC and Portable Tools can be edited." };
  const detailsResult = normalizeFields(Array.isArray(body.detailFields) ? body.detailFields : [], "Detail");
  if (detailsResult.error) return detailsResult;
  const questionsResult = normalizeFields(Array.isArray(body.reviewQuestions) ? body.reviewQuestions : [], "Question", true);
  if (questionsResult.error) return questionsResult;

  return {
    category: {
      id: existingId,
      name: existingId === "cat-elc" ? "ELC" : "Portable Tools",
      description: "",
      detailFields: detailsResult.fields,
      reviewQuestions: questionsResult.fields,
      createdAt: body.createdAt || nowIso(),
      updatedAt: nowIso()
    }
  };
}

function normalizeAnswers(fields, submittedValues, contextLabel) {
  const values = {};
  for (const field of fields || []) {
    const rawValue = submittedValues?.[field.id];
    let answer;
    if (field.type === "checkboxes") {
      const allowed = new Set(field.options || []);
      answer = (Array.isArray(rawValue) ? rawValue : [])
        .map(normalizeText)
        .filter((entry) => entry && allowed.has(entry));
    } else {
      answer = normalizeText(rawValue);
    }

    if (field.type === "image" && answer) {
      const answerImage = validateImageDataUrl(answer);
      if (answerImage.error) return { error: `${field.label} must be a valid image upload.` };
      answer = answerImage.value;
    }
    if (["radio", "select"].includes(field.type) && answer && !(field.options || []).includes(answer)) {
      return { error: `Choose one of the available answers for ${field.label}.` };
    }
    if (field.type === "yesno" && answer && !["Yes", "No"].includes(answer)) {
      return { error: `${field.label} must be answered Yes or No.` };
    }
    if (field.required && !hasAnswer(answer)) {
      return { error: `${field.label} is required ${contextLabel}.` };
    }
    values[field.id] = answer;
  }
  return { values };
}

function validateRequestPayload(db, body) {
  const itemName = normalizeText(body.itemName);
  const itemCode = normalizeText(body.itemCode) || `PT-${nanoid()}`;
  const site = normalizeText(body.site);
  const submittedBy = normalizeText(body.submittedBy);
  const categoryId = normalizeText(body.categoryId);
  const category = db.categories.find((entry) => entry.id === categoryId);

  if (!itemName) return { error: "Equipment Name is required." };
  if (!site) return { error: "Site is required." };
  if (!submittedBy) return { error: "Submitted by is required." };
  if (!category || !TOOL_TYPE_IDS.includes(category.id)) return { error: "Tool type must be ELC or Portable Tools." };

  const imageResult = validateImageList(body.toolImages, body.toolImage);
  if (imageResult.error) return { error: imageResult.error };

  const submittedDetails = body.detailValues && typeof body.detailValues === "object"
    ? body.detailValues
    : (body.powerValues && typeof body.powerValues === "object" ? body.powerValues : {});
  const detailResult = normalizeAnswers(category.detailFields || [], submittedDetails, "in the user details");
  if (detailResult.error) return detailResult;

  if (detailResult.values.fromDate && detailResult.values.toDate) {
    const fromDate = new Date(detailResult.values.fromDate);
    const toDate = new Date(detailResult.values.toDate);
    if (!Number.isNaN(fromDate.getTime()) && !Number.isNaN(toDate.getTime()) && toDate < fromDate) {
      return { error: "To Date cannot be earlier than From Date." };
    }
  }

  return {
    request: {
      id: `req-${nanoid()}`,
      referenceId: `REF-${nanoid()}`,
      itemName,
      itemCode,
      site,
      submittedBy,
      categoryId: category.id,
      categoryName: category.name,
      toolType: category.name,
      toolImages: imageResult.value,
      toolImage: imageResult.value[0] || "",
      detailValues: detailResult.values,
      detailsSnapshot: category.detailFields || [],
      reviewQuestionsSnapshot: category.reviewQuestions || [],
      reviewAnswers: {},
      approvalFlow: ["reviewer", "admin"],
      approvals: [],
      currentApprovalRole: "reviewer-or-admin",
      status: "pending",
      archivedAt: null,
      submittedAt: nowIso(),
      reviewedAt: null,
      reviewNote: ""
    }
  };
}

function pickExpiryDate(category, detailValues, explicitExpiresAt) {
  if (explicitExpiresAt) return explicitExpiresAt;
  if (detailValues?.toDate) return detailValues.toDate;
  const dateFields = (category.detailFields || []).filter((field) => field.type === "date");
  const requiredDate = dateFields.find((field) => field.required) || dateFields[0];
  if (requiredDate && detailValues?.[requiredDate.id]) return detailValues[requiredDate.id];
  return null;
}

function findRequestCategory(db, request) {
  return [...(db.categories || []), ...(db.legacyCategories || [])]
    .find((entry) => entry.id === request.categoryId);
}

function prepareReview(db, request, body, contextLabel) {
  ensureRequestWorkflow(request);
  if (request.status !== "pending") return { error: "Only pending requests can be reviewed.", status: 409 };

  const role = normalizeText(body?.role).toLowerCase();
  if (!requestCanBeActionedBy(request, role)) {
    return { error: "Reviewer or Admin access is required.", status: 403 };
  }

  const category = findRequestCategory(db, request);
  if (!category) return { error: "Request category no longer exists.", status: 400 };
  const questions = request.reviewQuestionsSnapshot || category.reviewQuestions || [];
  const answerResult = normalizeAnswers(
    questions,
    body?.reviewAnswers && typeof body.reviewAnswers === "object" ? body.reviewAnswers : {},
    contextLabel
  );
  if (answerResult.error) return { error: answerResult.error, status: 400 };

  return {
    role,
    category,
    questions,
    answers: answerResult.values,
    note: normalizeText(body?.reviewNote)
  };
}

function automaticReviewDecision(questions, answers) {
  const configured = (questions || []).filter((question) => question.autoDecision?.enabled);
  if (configured.length === 0) {
    return { error: "This request has no automatic question rules." };
  }

  const results = [];
  for (const question of configured) {
    const answer = normalizeText(answers?.[question.id]);
    const outcome = normalizeText(question.autoDecision?.outcomes?.[answer]).toLowerCase();
    if (!["approved", "rejected"].includes(outcome)) {
      return { error: `${question.label} does not have an automatic result for ${answer || "the selected answer"}.` };
    }
    results.push({ questionId: question.id, question: question.label, answer, outcome });
  }

  return {
    decision: results.some((result) => result.outcome === "rejected") ? "rejected" : "approved",
    results
  };
}

async function approvePreparedRequest(req, db, request, review, actor, decisionSource = "manual") {
  request.approvals = Array.isArray(request.approvals) ? request.approvals : [];
  const roleLabel = review.role === "admin" ? "Admin" : "Reviewer";
  request.approvals.push({
    role: review.role,
    roleLabel,
    approvedBy: actor,
    approvedAt: nowIso(),
    note: review.note,
    source: decisionSource
  });

  const expiresAt = pickExpiryDate(review.category, request.detailValues, req.body?.expiresAt);
  if (!expiresAt) return { error: "Expiry/validity date is required before final approval.", status: 400 };

  const qrId = `QR-${nanoid()}`;
  const qrPayload = getQrPayload(req, qrId);
  const qrImageDataUrl = await createBrandedQrDataUrl(qrPayload);
  const reviewedAt = nowIso();
  const item = {
    id: `asset-${nanoid()}`,
    qrId,
    qrPayload,
    qrImageDataUrl,
    qrBrand: "power-tool-v2",
    itemName: request.itemName,
    itemCode: request.itemCode,
    site: request.site,
    categoryId: request.categoryId,
    categoryName: request.categoryName,
    toolType: request.toolType || request.categoryName,
    toolImages: request.toolImages || (request.toolImage ? [request.toolImage] : []),
    toolImage: request.toolImage || "",
    detailValues: request.detailValues || {},
    detailsSnapshot: request.detailsSnapshot || review.category.detailFields || [],
    reviewAnswers: review.answers,
    reviewQuestionsSnapshot: review.questions,
    submittedBy: request.submittedBy,
    requestId: request.id,
    registeredAt: reviewedAt,
    approvedAt: reviewedAt,
    expiresAt,
    archivedAt: null,
    reviewNote: review.note,
    reviewedBy: actor,
    reviewedRole: review.role,
    reviewDecision: "approved",
    reviewDecisionSource: decisionSource,
    approvals: request.approvals || []
  };

  request.status = "approved";
  request.reviewedAt = reviewedAt;
  request.reviewNote = item.reviewNote;
  request.reviewAnswers = review.answers;
  request.reviewedBy = actor;
  request.reviewedRole = review.role;
  request.reviewDecisionSource = decisionSource;
  request.currentApprovalRole = "";
  request.itemId = item.id;
  db.items.push(item);
  return { item };
}

function rejectPreparedRequest(request, review, actor, decisionSource = "manual") {
  request.status = "rejected";
  request.reviewedAt = nowIso();
  request.currentApprovalRole = "";
  request.reviewNote = review.note;
  request.reviewAnswers = review.answers;
  request.rejectedBy = actor;
  request.rejectedRole = review.role;
  request.reviewDecisionSource = decisionSource;
  return request;
}

function sortItemsDefault(a, b) {
  const av = getItemValidity(a);
  const bv = getItemValidity(b);
  const aExpired = av.status === "expired" ? 0 : 1;
  const bExpired = bv.status === "expired" ? 0 : 1;
  if (aExpired !== bExpired) return aExpired - bExpired;
  return new Date(a.expiresAt || 0) - new Date(b.expiresAt || 0);
}

app.get("/api/health", (req, res) => {
  res.status(databaseState.ready ? 200 : 503).json({
    ok: databaseState.ready,
    database: publicDatabaseState(),
    time: nowIso()
  });
});

app.use("/api", (req, res, next) => {
  if (databaseState.ready) return next();
  scheduleDatabaseRetry(0);
  res.set("Retry-After", String(Math.ceil(DATABASE_RETRY_INTERVAL_MS / 1000)));
  return res.status(503).json({
    error: "The Power Tool local data store is still initializing.",
    database: publicDatabaseState()
  });
});

app.post("/api/auth/login", async (req, res) => {
  const db = await readDb();
  const username = normalizeText(req.body?.username).toLowerCase();
  const password = normalizeText(req.body?.password);
  const requestedRole = normalizeText(req.body?.role).toLowerCase();
  const account = (db.staffAccounts || []).find((entry) =>
    normalizeText(entry.username).toLowerCase() === username
    && (!requestedRole || normalizeText(entry.role).toLowerCase() === requestedRole)
    && entry.active !== false
  );
  if (!account || !verifyPassword(password, account.password)) {
    return res.status(401).json({ error: "Wrong username or password." });
  }
  const passwordUpgraded = upgradePasswordHash(account, password);
  const visitorSession = touchVisitorSession(db, req, {
    sessionId: req.body?.sessionId,
    path: req.body?.path,
    account
  });
  if (passwordUpgraded || visitorSession) await writeDb(db);
  if (visitorSession) await persistVisitorSession(req, visitorSession.session);
  res.json({
    username: account.username,
    displayName: account.displayName || account.username,
    role: account.role
  });
});

app.get("/api/staff/accounts", async (req, res) => {
  const db = await readDb();
  if (!isAdminActor(db, req.query.adminUsername)) {
    return res.status(403).json({ error: "Admin access is required." });
  }
  const accounts = (db.staffAccounts || [])
    .filter((account) => ["admin", "reviewer"].includes(normalizeText(account.role).toLowerCase()))
    .map(publicStaffAccount);
  res.json(sortStaffAccounts(accounts));
});

app.get("/api/staff/reviewers", async (req, res) => {
  const db = await readDb();
  if (!isAdminActor(db, req.query.adminUsername)) {
    return res.status(403).json({ error: "Admin access is required." });
  }
  const reviewers = (db.staffAccounts || [])
    .filter((account) => normalizeText(account.role).toLowerCase() === "reviewer")
    .map(publicReviewerAccount)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  res.json(reviewers);
});

app.post("/api/staff/reviewers", async (req, res) => {
  const db = await readDb();
  if (req.body?.adminPassword === undefined || !isAdminActor(db, req.body?.adminUsername, req.body?.adminPassword)) {
    return res.status(403).json({ error: "The Admin password is incorrect." });
  }

  const username = normalizeText(req.body?.username).toLowerCase();
  const password = normalizeText(req.body?.password);
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    return res.status(400).json({ error: "Reviewer username must be 3–40 characters using letters, numbers, dots, dashes, or underscores." });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: "Reviewer password must contain at least 4 characters." });
  }
  if ((db.staffAccounts || []).some((account) => normalizeText(account.username).toLowerCase() === username)) {
    return res.status(409).json({ error: "That username is already in use." });
  }

  const account = {
    id: `reviewer-${nanoid()}`,
    username,
    password: hashPassword(password),
    role: "reviewer",
    displayName: username,
    active: true,
    createdAt: nowIso()
  };
  db.staffAccounts.push(account);
  await writeDb(db);
  res.status(201).json(publicReviewerAccount(account));
});

app.delete("/api/staff/reviewers/:id", async (req, res) => {
  const db = await readDb();
  if (req.body?.adminPassword === undefined || !isAdminActor(db, req.body?.adminUsername, req.body?.adminPassword)) {
    return res.status(403).json({ error: "The Admin password is incorrect." });
  }
  const index = (db.staffAccounts || []).findIndex((account) =>
    account.id === req.params.id && normalizeText(account.role).toLowerCase() === "reviewer"
  );
  if (index === -1) return res.status(404).json({ error: "Reviewer account not found." });
  const reviewerCount = db.staffAccounts.filter((account) =>
    normalizeText(account.role).toLowerCase() === "reviewer"
  ).length;
  if (reviewerCount <= 1) {
    return res.status(409).json({ error: "Keep at least one Reviewer account." });
  }
  const [removed] = db.staffAccounts.splice(index, 1);
  await writeDb(db);
  res.json(publicReviewerAccount(removed));
});

app.get("/api/categories", async (req, res) => {
  const db = await readDb();
  res.json(db.categories || []);
});

app.post("/api/categories", async (req, res) => {
  res.status(405).json({ error: "Tool types are fixed to ELC and Portable Tools. Edit their User Details or Review Questions instead." });
});

app.put("/api/categories/:id", async (req, res) => {
  const db = await readDb();
  const index = db.categories.findIndex((entry) => entry.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Category not found." });
  const result = validateCategoryPayload(req.body, req.params.id);
  if (result.error) return res.status(400).json({ error: result.error });
  db.categories[index] = { ...result.category, createdAt: db.categories[index].createdAt };
  await writeDb(db);
  res.json(db.categories[index]);
});

app.delete("/api/categories/:id", async (req, res) => {
  res.status(405).json({ error: "ELC and Portable Tools are fixed tool types and cannot be deleted." });
});

app.post("/api/requests", async (req, res) => {
  const db = await readDb();
  const result = validateRequestPayload(db, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  db.requests.push(result.request);
  await writeDb(db);
  res.status(201).json(result.request);
});

app.get("/api/requests", async (req, res) => {
  const db = await readDb();
  const status = normalizeText(req.query.status);
  let changed = false;
  for (const request of db.requests || []) changed = ensureRequestWorkflow(request) || changed;
  if (changed) await writeDb(db);
  let requests = db.requests || [];
  if (status) requests = requests.filter((entry) => entry.status === status);
  requests = requests.sort((a, b) => {
    const pendingDiff = Number(a.status !== "pending") - Number(b.status !== "pending");
    if (pendingDiff) return pendingDiff;
    return new Date(b.submittedAt) - new Date(a.submittedAt);
  });
  res.json(requests);
});


app.get("/api/requests/reference/:referenceId", async (req, res) => {
  const db = await readDb();
  const referenceId = normalizeText(req.params.referenceId).toUpperCase();
  const request = (db.requests || []).find((entry) =>
    normalizeText(entry.referenceId || entry.id).toUpperCase() === referenceId
  );
  if (!request) return res.status(404).json({ error: "Reference ID not found." });

  const changedWorkflow = ensureRequestWorkflow(request);
  const item = request.itemId
    ? (db.items || []).find((entry) => entry.id === request.itemId)
    : null;

  const changedQr = item ? await ensureBrandedQrForItem(req, item) : false;
  if (changedWorkflow || changedQr) await writeDb(db);

  res.json({
    referenceId: request.referenceId || request.id,
    itemName: request.itemName,
    itemCode: request.itemCode,
    site: request.site,
    categoryName: request.categoryName,
    toolType: request.toolType || request.categoryName,
    toolImages: request.toolImages || (request.toolImage ? [request.toolImage] : []),
    toolImage: request.toolImage || "",
    status: request.status === "approved" ? "accepted" : request.status === "rejected" ? "rejected" : "pending",
    approvalFlow: request.approvalFlow || [],
    approvals: request.approvals || [],
    currentApprovalRole: request.currentApprovalRole || "",
    archivedAt: request.archivedAt || null,
    submittedAt: request.submittedAt,
    reviewedAt: request.reviewedAt,
    reviewNote: request.reviewNote || "",
    reviewedBy: request.reviewedBy || "",
    reviewedRole: request.reviewedRole || "",
    rejectedBy: request.rejectedBy || "",
    rejectedRole: request.rejectedRole || "",
    detailValues: request.detailValues || {},
    detailsSnapshot: request.detailsSnapshot || [],
    reviewQuestionsSnapshot: request.reviewQuestionsSnapshot || [],
    reviewAnswers: request.reviewAnswers || {},
    qrId: item?.qrId || "",
    qrPayload: item?.qrPayload || "",
    qrImageDataUrl: item?.qrImageDataUrl || "",
    expiresAt: item?.expiresAt || "",
    validity: item ? getItemValidity(item) : null
  });
});

app.get("/api/requests/:id", async (req, res) => {
  const db = await readDb();
  const request = (db.requests || []).find((entry) => entry.id === req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found." });
  if (ensureRequestWorkflow(request)) await writeDb(db);
  res.json(request);
});

app.post("/api/requests/:id/approve", async (req, res) => {
  const db = await readDb();
  const request = db.requests.find((entry) => entry.id === req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found." });
  const review = prepareReview(db, request, req.body, "before approval");
  if (review.error) return res.status(review.status).json({ error: review.error });
  if (review.questions.some((question) => question.autoDecision?.enabled)) {
    return res.status(409).json({ error: "Submit the configured automatic review instead of choosing Approve manually." });
  }
  const actor = normalizeText(req.body?.approvedBy) || (review.role === "admin" ? "Admin" : "Reviewer");
  const result = await approvePreparedRequest(req, db, request, review, actor);
  if (result.error) return res.status(result.status).json({ error: result.error });
  await writeDb(db);
  res.status(201).json({ request, item: { ...result.item, validity: getItemValidity(result.item) }, complete: true });
});

app.post("/api/requests/:id/reject", async (req, res) => {
  const db = await readDb();
  const request = db.requests.find((entry) => entry.id === req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found." });
  const review = prepareReview(db, request, req.body, "before rejection");
  if (review.error) return res.status(review.status).json({ error: review.error });
  if (review.questions.some((question) => question.autoDecision?.enabled)) {
    return res.status(409).json({ error: "Submit the configured automatic review instead of choosing Reject manually." });
  }
  const actor = normalizeText(req.body?.rejectedBy) || (review.role === "admin" ? "Admin" : "Reviewer");
  rejectPreparedRequest(request, review, actor);
  await writeDb(db);
  res.json(request);
});

app.post("/api/requests/:id/review", async (req, res) => {
  const db = await readDb();
  const request = db.requests.find((entry) => entry.id === req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found." });

  const review = prepareReview(db, request, req.body, "before submitting the review");
  if (review.error) return res.status(review.status).json({ error: review.error });
  const automatic = automaticReviewDecision(review.questions, review.answers);
  if (automatic.error) return res.status(400).json({ error: automatic.error });

  const actor = normalizeText(req.body?.reviewedBy) || (review.role === "admin" ? "Admin" : "Reviewer");
  request.automaticDecisionResults = automatic.results;
  if (automatic.decision === "approved") {
    const result = await approvePreparedRequest(req, db, request, review, actor, "automatic-question");
    if (result.error) return res.status(result.status).json({ error: result.error });
    await writeDb(db);
    return res.status(201).json({
      decision: "approved",
      request,
      item: { ...result.item, validity: getItemValidity(result.item) }
    });
  }

  rejectPreparedRequest(request, review, actor, "automatic-question");
  await writeDb(db);
  return res.json({ decision: "rejected", request });
});

app.post("/api/requests/:id/archive", async (req, res) => {
  const db = await readDb();
  const request = db.requests.find((entry) => entry.id === req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found." });
  if (request.status !== "rejected") return res.status(409).json({ error: "Only rejected requests can be archived here." });
  request.archivedAt = request.archivedAt || nowIso();
  request.archiveNote = normalizeText(req.body?.archiveNote);
  await writeDb(db);
  res.json(request);
});

app.post("/api/requests/:id/restore", async (req, res) => {
  const db = await readDb();
  const request = db.requests.find((entry) => entry.id === req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found." });
  request.archivedAt = null;
  request.archiveNote = "";
  await writeDb(db);
  res.json(request);
});

app.get("/api/items", async (req, res) => {
  const db = await readDb();
  let changedQrBranding = false;
  for (const item of db.items || []) {
    if (await ensureBrandedQrForItem(req, item)) changedQrBranding = true;
  }
  if (changedQrBranding) await writeDb(db);
  const search = normalizeText(req.query.search).toLowerCase();
  const categoryId = normalizeText(req.query.categoryId);
  const site = normalizeText(req.query.site).toLowerCase();
  const status = normalizeText(req.query.status);
  const sort = normalizeText(req.query.sort) || "expiry";
  const includeArchived = req.query.includeArchived === "true";

  let items = (db.items || []).map((item) => ({ ...item, validity: getItemValidity(item) }));

  if (!includeArchived) items = items.filter((item) => !item.archivedAt);
  if (search) {
    items = items.filter((item) => [
      item.itemName,
      item.itemCode,
      item.site,
      item.categoryName,
      item.toolType,
      item.qrId,
      ...Object.values(item.detailValues || {})
    ]
      .some((value) => normalizeText(value).toLowerCase().includes(search)));
  }
  if (categoryId) items = items.filter((item) => item.categoryId === categoryId);
  if (site) items = items.filter((item) => normalizeText(item.site).toLowerCase().includes(site));
  if (status) items = items.filter((item) => item.validity.status === status);

  if (sort === "alpha") items.sort((a, b) => a.itemName.localeCompare(b.itemName));
  else if (sort === "site") items.sort((a, b) => a.site.localeCompare(b.site) || a.itemName.localeCompare(b.itemName));
  else if (sort === "registered") items.sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt));
  else if (sort === "expired") items.sort((a, b) => Number(b.validity.isExpired) - Number(a.validity.isExpired) || sortItemsDefault(a, b));
  else items.sort(sortItemsDefault);

  res.json(items);
});

app.get("/api/items/qr/:qrId", async (req, res) => {
  const db = await readDb();
  const item = db.items.find((entry) => entry.qrId === req.params.qrId);
  if (!item) return res.status(404).json({ error: "QR item not found." });
  if (await ensureBrandedQrForItem(req, item)) await writeDb(db);
  const sourceRequest = (db.requests || []).find((entry) => entry.id === item.requestId || entry.itemId === item.id);
  res.json({
    ...item,
    referenceId: sourceRequest?.referenceId || "",
    validity: getItemValidity(item)
  });
});

app.get("/api/items/:id/qr", async (req, res) => {
  const db = await readDb();
  const item = db.items.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (await ensureBrandedQrForItem(req, item)) await writeDb(db);
  res.json({ qrId: item.qrId, qrPayload: item.qrPayload, qrImageDataUrl: item.qrImageDataUrl, qrBrand: item.qrBrand });
});

app.patch("/api/items/:id", async (req, res) => {
  const db = await readDb();
  const item = db.items.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found." });

  const editable = ["itemName", "itemCode", "site", "expiresAt", "reviewNote"];
  for (const key of editable) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) item[key] = req.body[key];
  }
  if (Object.prototype.hasOwnProperty.call(req.body, "toolImages") || Object.prototype.hasOwnProperty.call(req.body, "toolImage")) {
    const imageResult = validateImageList(req.body.toolImages, req.body.toolImage);
    if (imageResult.error) return res.status(400).json({ error: imageResult.error });
    item.toolImages = imageResult.value;
    item.toolImage = imageResult.value[0] || "";
  }
  if (req.body.detailValues && typeof req.body.detailValues === "object") {
    item.detailValues = { ...(item.detailValues || {}), ...req.body.detailValues };
  }
  if (req.body.reviewAnswers && typeof req.body.reviewAnswers === "object") {
    item.reviewAnswers = { ...(item.reviewAnswers || {}), ...req.body.reviewAnswers };
  }
  item.updatedAt = nowIso();
  await writeDb(db);
  res.json({ ...item, validity: getItemValidity(item) });
});

app.post("/api/items/:id/renew", async (req, res) => {
  const db = await readDb();
  const item = db.items.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (getItemValidity(item).status !== "expired") {
    return res.status(409).json({ error: "Only expired tools can be renewed." });
  }

  const role = normalizeText(req.body?.role).toLowerCase();
  if (!["reviewer", "admin"].includes(role)) {
    return res.status(403).json({ error: "Reviewer or Admin access is required." });
  }

  const questions = item.reviewQuestionsSnapshot || [];
  const answerResult = normalizeAnswers(
    questions,
    req.body?.reviewAnswers && typeof req.body.reviewAnswers === "object" ? req.body.reviewAnswers : {},
    "before renewal"
  );
  if (answerResult.error) return res.status(400).json({ error: answerResult.error });

  const expiresAt = normalizeText(req.body?.expiresAt);
  const expiryDate = expiresAt ? new Date(`${expiresAt}T23:59:59.999Z`) : null;
  if (!expiryDate || Number.isNaN(expiryDate.getTime()) || expiryDate.getTime() < Date.now()) {
    return res.status(400).json({ error: "Choose a new next-check date that has not already expired." });
  }

  const renewedBy = normalizeText(req.body?.renewedBy) || (role === "admin" ? "Admin" : "Reviewer");
  const feedback = normalizeText(req.body?.reviewNote);
  const renewal = {
    id: `renewal-${nanoid()}`,
    previousExpiresAt: item.expiresAt || "",
    expiresAt,
    reviewAnswers: answerResult.values,
    reviewNote: feedback,
    renewedBy,
    renewedRole: role,
    renewedAt: nowIso()
  };

  item.renewalHistory = Array.isArray(item.renewalHistory) ? item.renewalHistory : [];
  item.renewalHistory.push(renewal);
  item.expiresAt = expiresAt;
  item.reviewAnswers = answerResult.values;
  item.reviewNote = feedback;
  item.reviewedBy = renewedBy;
  item.reviewedRole = role;
  item.reviewDecision = "approved";
  item.updatedAt = nowIso();
  await writeDb(db);
  res.json({ ...item, validity: getItemValidity(item) });
});

app.post("/api/items/:id/archive", async (req, res) => {
  const db = await readDb();
  const item = db.items.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  item.archivedAt = item.archivedAt || nowIso();
  item.archiveNote = normalizeText(req.body?.archiveNote);
  await writeDb(db);
  res.json({ ...item, validity: getItemValidity(item) });
});

app.post("/api/items/:id/restore", async (req, res) => {
  const db = await readDb();
  const item = db.items.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found." });
  item.archivedAt = null;
  item.archiveNote = "";
  await writeDb(db);
  res.json({ ...item, validity: getItemValidity(item) });
});

app.post("/api/usage/visit", async (req, res) => {
  const db = await readDb();
  const sessionId = normalizeText(req.body?.sessionId).slice(0, 120);
  if (!sessionId) return res.status(400).json({ error: "Visit session ID is required." });

  const account = sessionAccountFromPayload(db, req.body);
  const visitorSession = touchVisitorSession(db, req, {
    sessionId,
    path: req.body?.path,
    account
  });
  await writeDb(db);
  await persistVisitorSession(req, visitorSession.session);
  if (visitorSession.isNew) {
    logUsage(
      visitorSession.usage,
      `new visitor session from ${visitorSession.session.ip} ipVisits=${visitorSession.ipRecord.visits}${visitorSession.session.path ? ` path=${visitorSession.session.path}` : ""}`
    );
  }
  res.json({ ok: true, counted: visitorSession.isNew });
});

app.post("/api/usage/event", async (req, res) => {
  const type = normalizeText(req.body?.type).toLowerCase();
  if (!["qr_open", "checklist_view"].includes(type)) {
    return res.status(400).json({ error: "Unknown usage event." });
  }

  const db = await readDb();
  const usage = ensureUsage(db);
  const ip = normalizeIp(req);
  const sessionId = normalizeText(req.body?.sessionId).slice(0, 120) || `anonymous-${ip}`;
  const targetId = normalizeText(req.body?.targetId).slice(0, 120) || "unknown";
  const eventKey = `${sessionId}:${type}:${targetId}`;
  const visitorSession = touchVisitorSession(db, req, {
    sessionId,
    path: req.body?.path
  });
  const ipRecord = visitorSession.ipRecord;
  const existingEvent = usage.events[eventKey];

  if (!existingEvent) {
    usage.events[eventKey] = { type, targetId, sessionId, ip, createdAt: nowIso() };
    if (type === "qr_open") {
      usage.totalQrOpens += 1;
      ipRecord.qrOpens += 1;
    } else {
      usage.totalChecklistViews += 1;
      ipRecord.checklistViews += 1;
    }
  }

  trimUsageHistory(usage, "events", 10000);
  await writeDb(db);
  await persistVisitorSession(req, visitorSession.session);
  res.json({ ok: true, counted: !existingEvent });
});

app.post("/api/usage/session/logout", async (req, res) => {
  const db = await readDb();
  const sessionId = normalizeText(req.body?.sessionId).slice(0, 120);
  if (!sessionId) return res.status(400).json({ error: "Visit session ID is required." });

  const visitorSession = touchVisitorSession(db, req, {
    sessionId,
    path: req.body?.path,
    markLogout: true
  });
  await writeDb(db);
  await persistVisitorSession(req, visitorSession.session);
  res.json({ ok: true });
});

app.post("/api/usage/session/end", async (req, res) => {
  const db = await readDb();
  const sessionId = normalizeText(req.body?.sessionId).slice(0, 120);
  if (!sessionId) return res.status(400).json({ error: "Visit session ID is required." });

  const visitorSession = touchVisitorSession(db, req, {
    sessionId,
    path: req.body?.path,
    markEnded: true
  });
  await writeDb(db);
  await persistVisitorSession(req, visitorSession.session);
  res.json({ ok: true });
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: `API route ${req.method} ${req.originalUrl} was not found.` });
});

const distPath = path.join(__dirname, "..", "dist");
app.use(express.static(distPath));
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(distPath, "index.html"), (err) => {
    if (err) next();
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (isDatabaseConnectionError(err)) {
    markDatabaseUnavailable(err);
    res.set("Retry-After", String(Math.ceil(DATABASE_RETRY_INTERVAL_MS / 1000)));
    return res.status(503).json({
      error: "The Power Tool database connection was interrupted. The application will reconnect automatically.",
      database: publicDatabaseState()
    });
  }
  const body = { error: "Server error." };
  if (/^(1|true|yes|on)$/i.test(String(process.env.EXPOSE_ERROR_DETAILS || ""))) {
    body.detail = err.message;
  }
  res.status(500).json(body);
});

let httpServer;

async function startServer() {
  httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Power Tool backend listening on port ${PORT}`);
    startDatabaseMonitor();
    connectDataStore().catch(() => {});
  });
}

async function shutdown(signal) {
  shuttingDown = true;
  if (databaseRetryTimer) {
    clearTimeout(databaseRetryTimer);
    databaseRetryTimer = undefined;
  }
  if (databaseMonitorTimer) {
    clearInterval(databaseMonitorTimer);
    databaseMonitorTimer = undefined;
  }
  console.log(`[Server] ${signal} received. Closing connections.`);
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await closeDb();
  process.exit(0);
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    console.error(error);
    process.exit(1);
  });
});
process.on("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    console.error(error);
    process.exit(1);
  });
});

startServer().catch((error) => {
  console.error(`[Server] Startup failed: ${error.message}`);
  process.exit(1);
});
