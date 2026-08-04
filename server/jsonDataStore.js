// Legacy JSON store retained for one-time PostgreSQL import and local fallback.
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { hashPassword, isPasswordHash } from "./passwords.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = String(process.env.POWER_TOOL_DATA_DIR || "").trim()
  ? path.resolve(process.env.POWER_TOOL_DATA_DIR)
  : path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const CURRENT_DB_VERSION = 11;
let ensurePromise;
let writeQueue = Promise.resolve();
let tempFileCounter = 0;

function nowIso() {
  return new Date().toISOString();
}

function environmentText(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

function configuredPassword(name) {
  const password = environmentText(name);
  return password ? hashPassword(password) : "";
}

function storedPassword(value) {
  const password = String(value ?? "");
  if (!password) return "";
  return isPasswordHash(password) ? password : hashPassword(password);
}

function initialStaffAccounts() {
  const reviewerUsername = environmentText("INITIAL_REVIEWER_USERNAME", "reviewer");
  const adminUsername = environmentText("ADMIN_USERNAME", "admin");
  return [
    {
      id: "reviewer",
      username: reviewerUsername,
      password: configuredPassword("INITIAL_REVIEWER_PASSWORD"),
      role: "reviewer",
      displayName: reviewerUsername,
      createdAt: nowIso()
    },
    {
      id: "admin",
      username: adminUsername,
      password: configuredPassword("ADMIN_PASSWORD"),
      role: "admin",
      displayName: adminUsername,
      createdAt: nowIso()
    }
  ];
}

function assertInitialAccountsConfigured(accounts) {
  const missing = accounts
    .filter((account) => !account.password)
    .map((account) => account.role === "admin" ? "ADMIN_PASSWORD" : "INITIAL_REVIEWER_PASSWORD");
  if (missing.length) {
    throw new Error(
      `${missing.join(" and ")} must be set in .env before initializing an empty database.`
    );
  }
}

function defaultElcDetails() {
  return [
    { id: "moduleType", label: "Module Type", type: "text", required: true, placeholder: "", options: [] },
    { id: "searchType", label: "Search Type", type: "text", required: true, placeholder: "", options: [] },
    { id: "fromDate", label: "From Date", type: "date", required: true, placeholder: "", options: [] },
    { id: "toDate", label: "To Date", type: "date", required: true, placeholder: "", options: [] },
    { id: "machine", label: "Machine", type: "text", required: true, placeholder: "", options: [] },
    { id: "powerSupply", label: "Power Supply (N/A if none)", type: "text", required: true, placeholder: "", options: [] },
    { id: "vendor", label: "Vendor", type: "text", required: true, placeholder: "", options: [] }
  ];
}

function powerToolCategories() {
  return [
    {
      id: "cat-elc",
      name: "ELC",
      description: "",
      detailFields: defaultElcDetails(),
      reviewQuestions: [],
      createdAt: nowIso()
    },
    {
      id: "cat-portable-tool",
      name: "Portable Tools",
      description: "",
      detailFields: [],
      reviewQuestions: [],
      createdAt: nowIso()
    }
  ];
}

const starterDb = {
  meta: {
    appName: "Power Tool",
    version: CURRENT_DB_VERSION,
    updatedAt: nowIso()
  },
  categories: powerToolCategories(),
  legacyCategories: [],
  staffAccounts: initialStaffAccounts(),
  requests: [],
  items: [],
  usage: {
    totalVisits: 0,
    totalQrOpens: 0,
    totalChecklistViews: 0,
    ips: {},
    sessions: {},
    events: {}
  }
};

function completeJsonDocumentEnd(raw) {
  let started = false;
  let inString = false;
  let escaped = false;
  let depth = 0;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];

    if (!started) {
      if (/\s/.test(character)) continue;
      if (!["{", "["].includes(character)) return -1;
      started = true;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
    } else if (["{", "["].includes(character)) {
      depth += 1;
    } else if (["}", "]"].includes(character)) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }

  return -1;
}

function parseDbJson(raw) {
  try {
    return { db: JSON.parse(raw), recoveredTrailingData: false };
  } catch (originalError) {
    const documentEnd = completeJsonDocumentEnd(raw);
    if (documentEnd < 0 || !raw.slice(documentEnd).trim()) throw originalError;

    try {
      return {
        db: JSON.parse(raw.slice(0, documentEnd)),
        recoveredTrailingData: true
      };
    } catch {
      throw originalError;
    }
  }
}

async function atomicWriteDb(db) {
  const tempPath = path.join(
    DATA_DIR,
    `.db.${process.pid}.${Date.now()}.${tempFileCounter += 1}.tmp`
  );
  const serialized = `${JSON.stringify(db, null, 2)}\n`;

  try {
    await fs.writeFile(tempPath, serialized, { encoding: "utf8", flag: "wx" });
    await fs.rename(tempPath, DB_PATH);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

function enqueueWrite(db) {
  const operation = writeQueue.then(
    () => atomicWriteDb(db),
    () => atomicWriteDb(db)
  );
  writeQueue = operation.catch(() => {});
  return operation;
}

function normalizeQuestion(question, index) {
  const label = String(question?.label || "").trim();
  if (!label) return null;
  const type = ["text", "number", "date", "textarea", "radio", "checkboxes", "select", "yesno", "image"].includes(question.type)
    ? question.type
    : "text";
  const options = ["radio", "checkboxes", "select"].includes(type)
    ? (Array.isArray(question.options) ? question.options : []).map(String).filter(Boolean)
    : [];
  const automaticAnswers = type === "yesno"
    ? ["Yes", "No"]
    : (["radio", "select"].includes(type) ? options : []);
  const submittedOutcomes = question.autoDecision?.outcomes && typeof question.autoDecision.outcomes === "object"
    ? question.autoDecision.outcomes
    : {};
  const outcomes = Object.fromEntries(
    automaticAnswers.map((answer) => [answer, String(submittedOutcomes[answer] || "").trim().toLowerCase()])
  );
  const outcomeValues = Object.values(outcomes);
  const automaticEnabled = Boolean(question.autoDecision?.enabled)
    && automaticAnswers.length > 0
    && outcomeValues.every((outcome) => ["approved", "rejected"].includes(outcome))
    && outcomeValues.includes("approved")
    && outcomeValues.includes("rejected");
  return {
    id: question.id || `question-${index + 1}`,
    label,
    type,
    required: automaticEnabled ? true : Boolean(question.required),
    placeholder: String(question.placeholder || "").trim(),
    options,
    autoDecision: {
      enabled: automaticEnabled,
      outcomes: automaticEnabled ? outcomes : {}
    }
  };
}

function normalizedStaffAccounts(db, sourceVersion) {
  const currentAccounts = Array.isArray(db.staffAccounts) ? db.staffAccounts : [];
  const legacyAccounts = Array.isArray(db.adminUsers) ? db.adminUsers : [];
  const allAccounts = [...currentAccounts, ...legacyAccounts];
  const legacyAdmin = db.adminAccount && typeof db.adminAccount === "object"
    ? db.adminAccount
    : null;

  const previousReviewer = allAccounts.find((account) =>
    String(account?.role || "").trim().toLowerCase() === "reviewer"
  ) || allAccounts.find((account) =>
    ["security", "engineering"].includes(
      String(account?.role || account?.username || "").trim().toLowerCase()
    )
  );
  const previousAdmin = allAccounts.find((account) =>
    String(account?.role || "").trim().toLowerCase() === "admin"
  ) || legacyAdmin || allAccounts.find((account) =>
    ["admin", "all"].includes(
      String(account?.role || account?.username || "").trim().toLowerCase()
    )
  );

  const fallbackReviewer = starterDb.staffAccounts.find((account) => account.role === "reviewer");
  const fallbackAdmin = starterDb.staffAccounts.find((account) => account.role === "admin");

  const normalizeAccount = (account, fallback, index = 0) => ({
    ...fallback,
    ...account,
    id: String(account?.id || `${fallback.role}-${index + 1}`).trim() || `${fallback.role}-${index + 1}`,
    role: fallback.role,
    username: String(account?.username || fallback.username).trim() || fallback.username,
    password: storedPassword(account?.password || fallback.password),
    displayName: String(account?.displayName || account?.username || fallback.displayName).trim() || fallback.displayName,
    createdAt: account?.createdAt || fallback.createdAt,
    active: account?.active !== false
  });

  if (sourceVersion < 7) {
    const reviewerSource = fallbackReviewer.password ? fallbackReviewer : previousReviewer;
    const adminSource = fallbackAdmin.password ? fallbackAdmin : previousAdmin;
    return [
      normalizeAccount(adminSource, fallbackAdmin),
      normalizeAccount(reviewerSource, fallbackReviewer)
    ];
  }

  const normalizedAdmin = normalizeAccount(previousAdmin, fallbackAdmin);
  const admin = sourceVersion < 10
    ? {
        ...normalizedAdmin,
        id: "admin",
        username: fallbackAdmin.username,
        password: fallbackAdmin.password || normalizedAdmin.password,
        displayName: fallbackAdmin.username,
        active: true
      }
    : normalizedAdmin;
  const reviewerSources = currentAccounts.filter((account) =>
    String(account?.role || "").trim().toLowerCase() === "reviewer"
  );
  if (reviewerSources.length === 0 && previousReviewer) reviewerSources.push(previousReviewer);
  if (reviewerSources.length === 0) reviewerSources.push(fallbackReviewer);

  const usedUsernames = new Set([admin.username.toLowerCase()]);
  const reviewers = reviewerSources
    .map((account, index) => normalizeAccount(account, fallbackReviewer, index))
    .map((account) => sourceVersion < 10
      ? { ...account, displayName: account.username }
      : account)
    .filter((account) => {
      const username = account.username.toLowerCase();
      if (!username || usedUsernames.has(username)) return false;
      usedUsernames.add(username);
      return true;
    });

  if (reviewers.length === 0) reviewers.push(normalizeAccount(fallbackReviewer, fallbackReviewer));
  return [admin, ...reviewers];
}

function migrateDb(db) {
  let changed = false;
  const next = db && typeof db === "object" ? db : {};
  const version = Number(next.meta?.version || 1);

  next.requests = Array.isArray(next.requests) ? next.requests : [];
  next.items = Array.isArray(next.items) ? next.items : [];
  next.legacyCategories = Array.isArray(next.legacyCategories) ? next.legacyCategories : [];

  const staffAccounts = normalizedStaffAccounts(next, version);
  if (JSON.stringify(next.staffAccounts) !== JSON.stringify(staffAccounts)) {
    next.staffAccounts = staffAccounts;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(next, "adminAccount")) {
    delete next.adminAccount;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(next, "adminUsers")) {
    delete next.adminUsers;
    changed = true;
  }

  if (version < 2) {
    const existingCategories = Array.isArray(next.categories) ? next.categories : [];
    const knownLegacyIds = new Set(next.legacyCategories.map((category) => category.id));
    for (const category of existingCategories) {
      if (!knownLegacyIds.has(category.id) && !["cat-elc", "cat-portable-tool"].includes(category.id)) {
        next.legacyCategories.push(category);
      }
    }
    next.categories = powerToolCategories();
    changed = true;
  }

  const defaults = powerToolCategories();
  if (version < 4) {
    const existingCategories = Array.isArray(next.categories) ? next.categories : [];
    next.categories = defaults.map((fallback) => {
      const existing = existingCategories.find((category) => category.id === fallback.id);
      return {
        ...fallback,
        createdAt: existing?.createdAt || fallback.createdAt
      };
    });
    changed = true;
  }
  if (!Array.isArray(next.categories)) {
    next.categories = defaults;
    changed = true;
  }
  for (const fallback of defaults) {
    const current = next.categories.find((category) => category.id === fallback.id);
    if (!current) {
      next.categories.push(fallback);
      changed = true;
      continue;
    }
    if (current.name !== fallback.name || current.description !== "") {
      current.name = fallback.name;
      current.description = "";
      changed = true;
    }
    const normalizedDetails = (Array.isArray(current.detailFields)
      ? current.detailFields
      : fallback.detailFields)
      .map(normalizeQuestion)
      .filter(Boolean);
    const normalizedQuestions = (Array.isArray(current.reviewQuestions)
      ? current.reviewQuestions
      : (Array.isArray(current.fields) ? current.fields : []))
      .map(normalizeQuestion)
      .filter(Boolean);
    if (!Array.isArray(current.detailFields) || JSON.stringify(normalizedDetails) !== JSON.stringify(current.detailFields)) {
      current.detailFields = normalizedDetails;
      changed = true;
    }
    if (!Array.isArray(current.reviewQuestions) || JSON.stringify(normalizedQuestions) !== JSON.stringify(current.reviewQuestions)) {
      current.reviewQuestions = normalizedQuestions;
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(current, "fields")) {
      delete current.fields;
      changed = true;
    }
  }
  const activeCategories = next.categories.filter((category) => ["cat-elc", "cat-portable-tool"].includes(category.id));
  if (activeCategories.length !== next.categories.length) changed = true;
  next.categories = activeCategories;

  for (const record of [...next.requests, ...next.items]) {
    if (!record || typeof record !== "object") continue;
    const normalizedImages = (
      Array.isArray(record.toolImages)
        ? record.toolImages
        : (record.toolImage ? [record.toolImage] : [])
    ).filter((image) => typeof image === "string" && image.trim());
    if (JSON.stringify(record.toolImages || []) !== JSON.stringify(normalizedImages)) {
      record.toolImages = normalizedImages;
      changed = true;
    }
    const primaryImage = normalizedImages[0] || "";
    if ((record.toolImage || "") !== primaryImage) {
      record.toolImage = primaryImage;
      changed = true;
    }
  }

  for (const item of next.items) {
    if (!item || typeof item !== "object") continue;
    if (!Array.isArray(item.renewalHistory)) {
      item.renewalHistory = [];
      changed = true;
    }
  }

  if (version < 6) {
    for (const request of next.requests) {
      if (!request || typeof request !== "object") continue;
      request.approvalFlow = ["reviewer", "admin"];
      request.currentApprovalRole = request.status === "pending" ? "reviewer-or-admin" : "";
      request.approvals = Array.isArray(request.approvals) ? request.approvals : [];
      request.detailValues = request.detailValues || request.powerValues || {};
      request.detailsSnapshot = request.detailsSnapshot || request.powerFieldsSnapshot || [];
      request.reviewQuestionsSnapshot = request.reviewQuestionsSnapshot || request.fieldsSnapshot || [];
      request.reviewAnswers = request.reviewAnswers || {};
      request.archivedAt = request.archivedAt || null;
    }
    for (const item of next.items) {
      if (!item || typeof item !== "object") continue;
      item.detailValues = item.detailValues || item.powerValues || {};
      item.detailsSnapshot = item.detailsSnapshot || item.powerFieldsSnapshot || [];
      item.reviewQuestionsSnapshot = item.reviewQuestionsSnapshot || item.fieldsSnapshot || [];
      item.reviewAnswers = item.reviewAnswers || item.values || {};
    }
    changed = true;
  }

  if (!next.usage || typeof next.usage !== "object") {
    next.usage = { ...starterDb.usage };
    changed = true;
  } else {
    for (const key of ["totalVisits", "totalQrOpens", "totalChecklistViews"]) {
      if (!Number.isFinite(Number(next.usage[key]))) {
        next.usage[key] = 0;
        changed = true;
      }
    }
    for (const key of ["ips", "sessions", "events"]) {
      if (!next.usage[key] || typeof next.usage[key] !== "object" || Array.isArray(next.usage[key])) {
        next.usage[key] = {};
        changed = true;
      }
    }
  }

  if (next.meta?.appName !== "Power Tool" || Number(next.meta?.version) !== CURRENT_DB_VERSION) {
    next.meta = {
      ...(next.meta || {}),
      appName: "Power Tool",
      version: CURRENT_DB_VERSION,
      updatedAt: nowIso()
    };
    changed = true;
  }

  return { db: next, changed };
}

async function ensureDb() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      try {
        await fs.access(DB_PATH);
      } catch {
        assertInitialAccountsConfigured(starterDb.staffAccounts);
        await enqueueWrite(starterDb);
      }
    })().catch((error) => {
      ensurePromise = undefined;
      throw error;
    });
  }
  await ensurePromise;
}

export async function readDb() {
  await ensureDb();
  await writeQueue;
  const raw = await fs.readFile(DB_PATH, "utf8");
  const parsed = parseDbJson(raw);
  const migrated = migrateDb(parsed.db);
  if (parsed.recoveredTrailingData || migrated.changed) {
    await enqueueWrite(migrated.db);
    if (parsed.recoveredTrailingData) {
      console.warn("[Database] Removed trailing data after the valid JSON document.");
    }
  }
  return migrated.db;
}

export async function writeDb(db) {
  await ensureDb();
  const next = {
    ...db,
    meta: {
      ...(db.meta || {}),
      appName: "Power Tool",
      version: CURRENT_DB_VERSION,
      updatedAt: nowIso()
    }
  };
  await enqueueWrite(next);
  return next;
}

export function getDbPath() {
  return DB_PATH;
}
