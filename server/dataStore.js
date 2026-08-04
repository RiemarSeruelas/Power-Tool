import "dotenv/config";
import pg from "pg";
import * as jsonStore from "./jsonDataStore.js";

const { Pool } = pg;
const POSTGRES_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.POSTGRES_ENABLED || "").trim()
);
const COLLECTIONS = {
  categories: "power_tool_categories",
  legacyCategories: "power_tool_legacy_categories",
  staffAccounts: "power_tool_staff_accounts",
  requests: "power_tool_requests",
  items: "power_tool_items"
};
const POWER_TOOL_LOGS_TABLE = "PowerTool-logs";
const BASELINE = Symbol("powerToolPostgresBaseline");

let pool;
let ensurePromise;

function quotedIdentifier(value, label) {
  const identifier = String(value || "").trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function schemaName() {
  return String(process.env.POSTGRES_SCHEMA || "app").trim() || "app";
}

function tableName(name) {
  return `${quotedIdentifier(schemaName(), "POSTGRES_SCHEMA")}.${quotedIdentifier(name, "PostgreSQL table name")}`;
}

function powerToolLogsTableName() {
  return `${quotedIdentifier(schemaName(), "POSTGRES_SCHEMA")}."${POWER_TOOL_LOGS_TABLE}"`;
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required when POSTGRES_ENABLED=true.`);
  return value;
}

function numberEnvironment(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name] || fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function postgresSsl() {
  const mode = String(process.env.POSTGRES_SSL || "false").trim().toLowerCase();
  if (["1", "true", "yes", "on", "require"].includes(mode)) {
    return { rejectUnauthorized: false };
  }
  return false;
}

function getPool() {
  if (!pool) {
    const PoolImplementation = globalThis.__POWER_TOOL_POSTGRES_POOL__ || Pool;
    pool = new PoolImplementation({
      host: requiredEnvironment("POSTGRES_HOST"),
      port: numberEnvironment("POSTGRES_PORT", 5432, 1, 65535),
      database: requiredEnvironment("POSTGRES_DB"),
      user: requiredEnvironment("POSTGRES_USER"),
      password: requiredEnvironment("POSTGRES_PASSWORD"),
      max: numberEnvironment("POSTGRES_POOL_MAX", 20, 1, 100),
      idleTimeoutMillis: numberEnvironment("POSTGRES_IDLE_TIMEOUT_MS", 30000, 1000, 600000),
      connectionTimeoutMillis: numberEnvironment("POSTGRES_CONNECT_TIMEOUT_MS", 10000, 1000, 120000),
      ssl: postgresSsl(),
      application_name: "power-tool-system"
    });
    pool.on("error", (error) => {
      console.error(`[PostgreSQL] Idle client error: ${error.message}`);
    });
  }
  return pool;
}

function serialized(value) {
  return JSON.stringify(value ?? null);
}

function collectionMap(records) {
  const map = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const id = String(record?.id || "").trim();
    if (!id) continue;
    map.set(id, serialized(record));
  }
  return map;
}

function baselineFor(db) {
  const collections = {};
  for (const key of Object.keys(COLLECTIONS)) {
    collections[key] = collectionMap(db[key]);
  }
  return {
    collections,
    meta: serialized(db.meta || {}),
    usage: structuredClone(db.usage || {})
  };
}

function attachBaseline(db) {
  Object.defineProperty(db, BASELINE, {
    value: baselineFor(db),
    configurable: true,
    enumerable: false,
    writable: false
  });
  return db;
}

function emptyUsage() {
  return {
    totalVisits: 0,
    totalQrOpens: 0,
    totalChecklistViews: 0,
    ips: {},
    sessions: {},
    events: {}
  };
}

function normalizeUsage(value) {
  const source = value && typeof value === "object" ? structuredClone(value) : {};
  return {
    totalVisits: Number(source.totalVisits || 0),
    totalQrOpens: Number(source.totalQrOpens || 0),
    totalChecklistViews: Number(source.totalChecklistViews || 0),
    ips: source.ips && typeof source.ips === "object" && !Array.isArray(source.ips) ? source.ips : {},
    sessions: source.sessions && typeof source.sessions === "object" && !Array.isArray(source.sessions) ? source.sessions : {},
    events: source.events && typeof source.events === "object" && !Array.isArray(source.events) ? source.events : {}
  };
}

function ensureIp(usage, ip, source = {}) {
  const key = String(ip || source.ip || "unknown");
  if (!usage.ips[key]) {
    usage.ips[key] = {
      ip: key,
      visits: 0,
      qrOpens: 0,
      checklistViews: 0,
      firstSeenAt: source.firstSeenAt || new Date().toISOString(),
      lastSeenAt: source.lastSeenAt || new Date().toISOString(),
      lastPath: source.lastPath || ""
    };
  }
  return usage.ips[key];
}

function laterTimestamp(left, right) {
  const leftTime = new Date(left || 0).getTime();
  const rightTime = new Date(right || 0).getTime();
  return rightTime >= leftTime ? (right || left) : left;
}

function trimObjectByDate(value, limit) {
  const entries = Object.entries(value || {});
  if (entries.length <= limit) return value || {};
  return Object.fromEntries(
    entries
      .sort((a, b) => new Date(b[1]?.lastSeenAt || b[1]?.createdAt || 0) - new Date(a[1]?.lastSeenAt || a[1]?.createdAt || 0))
      .slice(0, limit)
  );
}

function mergeUsage(storedValue, baselineValue, desiredValue) {
  const stored = normalizeUsage(storedValue);
  const baseline = normalizeUsage(baselineValue);
  const desired = normalizeUsage(desiredValue);

  for (const [sessionId, session] of Object.entries(desired.sessions)) {
    const baselineSession = baseline.sessions[sessionId];
    const storedSession = stored.sessions[sessionId];
    if (!baselineSession && !storedSession) {
      stored.sessions[sessionId] = session;
      stored.totalVisits += 1;
      ensureIp(stored, session.ip, desired.ips?.[session.ip]).visits += 1;
    } else if (baselineSession && serialized(session) !== serialized(baselineSession)) {
      stored.sessions[sessionId] = {
        ...(storedSession || baselineSession),
        ...session,
        lastSeenAt: laterTimestamp(storedSession?.lastSeenAt, session.lastSeenAt)
      };
    }
  }

  for (const sessionId of Object.keys(baseline.sessions)) {
    if (!desired.sessions[sessionId] && serialized(stored.sessions[sessionId]) === serialized(baseline.sessions[sessionId])) {
      delete stored.sessions[sessionId];
    }
  }

  for (const [eventKey, event] of Object.entries(desired.events)) {
    if (!baseline.events[eventKey] && !stored.events[eventKey]) {
      stored.events[eventKey] = event;
      const ipRecord = ensureIp(stored, event.ip, desired.ips?.[event.ip]);
      if (event.type === "qr_open") {
        stored.totalQrOpens += 1;
        ipRecord.qrOpens += 1;
      } else if (event.type === "checklist_view") {
        stored.totalChecklistViews += 1;
        ipRecord.checklistViews += 1;
      }
    }
  }

  for (const eventKey of Object.keys(baseline.events)) {
    if (!desired.events[eventKey] && serialized(stored.events[eventKey]) === serialized(baseline.events[eventKey])) {
      delete stored.events[eventKey];
    }
  }

  for (const [ip, desiredIp] of Object.entries(desired.ips)) {
    const storedIp = ensureIp(stored, ip, desiredIp);
    storedIp.firstSeenAt = storedIp.firstSeenAt || desiredIp.firstSeenAt;
    storedIp.lastSeenAt = laterTimestamp(storedIp.lastSeenAt, desiredIp.lastSeenAt);
    if (desiredIp.lastPath) storedIp.lastPath = desiredIp.lastPath;
  }

  stored.sessions = trimObjectByDate(stored.sessions, 5000);
  stored.events = trimObjectByDate(stored.events, 10000);
  return stored;
}

async function createTables(client) {
  const schema = quotedIdentifier(schemaName(), "POSTGRES_SCHEMA");
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${tableName("power_tool_meta")} (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      record jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${tableName("power_tool_usage")} (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      record jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${powerToolLogsTableName()} (
      id bigserial PRIMARY KEY,
      event_type text NOT NULL,
      event_key text NOT NULL,
      session_id text NOT NULL DEFAULT '',
      ip_address text NOT NULL DEFAULT 'unknown',
      request_path text NOT NULL DEFAULT '',
      request_method text NOT NULL DEFAULT '',
      response_status integer NOT NULL DEFAULT 200,
      user_agent text NOT NULL DEFAULT '',
      target_id text NOT NULL DEFAULT '',
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT power_tool_logs_event_key_unique UNIQUE (event_type, event_key)
    )
  `);

  for (const table of Object.values(COLLECTIONS)) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${tableName(table)} (
        id text PRIMARY KEY,
        record jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  await client.query(`
    CREATE INDEX IF NOT EXISTS power_tool_requests_status_idx
    ON ${tableName(COLLECTIONS.requests)} ((record->>'status'))
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS power_tool_requests_reference_idx
    ON ${tableName(COLLECTIONS.requests)} (upper(COALESCE(record->>'referenceId', record->>'id')))
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS power_tool_items_qr_idx
    ON ${tableName(COLLECTIONS.items)} ((record->>'qrId'))
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS power_tool_items_expiry_idx
    ON ${tableName(COLLECTIONS.items)} ((record->>'expiresAt'))
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS power_tool_staff_username_idx
    ON ${tableName(COLLECTIONS.staffAccounts)} (lower(record->>'username'))
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS power_tool_logs_created_at_idx
    ON ${powerToolLogsTableName()} (created_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS power_tool_logs_event_type_idx
    ON ${powerToolLogsTableName()} (event_type, created_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS power_tool_logs_ip_address_idx
    ON ${powerToolLogsTableName()} (ip_address, created_at DESC)
  `);
}

async function insertSingleton(client, table, value) {
  await client.query(
    `INSERT INTO ${tableName(table)} (singleton, record)
     VALUES (true, $1::jsonb)
     ON CONFLICT (singleton) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
    [serialized(value)]
  );
}

async function insertCollection(client, table, records) {
  for (const record of Array.isArray(records) ? records : []) {
    const id = String(record?.id || "").trim();
    if (!id) continue;
    await client.query(
      `INSERT INTO ${tableName(table)} (id, record)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
      [id, serialized(record)]
    );
  }
}

async function seedPostgres(client) {
  const source = await jsonStore.readDb();
  await insertSingleton(client, "power_tool_meta", source.meta || {});
  await insertSingleton(client, "power_tool_usage", source.usage || emptyUsage());
  for (const [key, table] of Object.entries(COLLECTIONS)) {
    await insertCollection(client, table, source[key]);
  }
  console.log(
    `[PostgreSQL] Imported JSON database: categories=${source.categories?.length || 0} requests=${source.requests?.length || 0} items=${source.items?.length || 0} accounts=${source.staffAccounts?.length || 0}`
  );
}

async function ensurePostgres() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `${schemaName()}.power_tool_initialize_v1`
        ]);
        await createTables(client);
        const result = await client.query(
          `SELECT 1 FROM ${tableName("power_tool_meta")} WHERE singleton = true`
        );
        if (result.rowCount === 0) await seedPostgres(client);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    })().catch((error) => {
      ensurePromise = undefined;
      throw error;
    });
  }
  await ensurePromise;
}

async function readPostgresDb() {
  await ensurePostgres();
  const client = await getPool().connect();
  try {
    const [metaResult, usageResult, ...collectionResults] = await Promise.all([
      client.query(`SELECT record FROM ${tableName("power_tool_meta")} WHERE singleton = true`),
      client.query(`SELECT record FROM ${tableName("power_tool_usage")} WHERE singleton = true`),
      ...Object.values(COLLECTIONS).map((table) =>
        client.query(`SELECT record FROM ${tableName(table)} ORDER BY id`)
      )
    ]);
    const db = {
      meta: metaResult.rows[0]?.record || {},
      usage: usageResult.rows[0]?.record || emptyUsage()
    };
    Object.keys(COLLECTIONS).forEach((key, index) => {
      db[key] = collectionResults[index].rows.map((row) => row.record);
    });
    return attachBaseline(db);
  } finally {
    client.release();
  }
}

async function writeCollectionChanges(client, key, desiredRecords, baseline) {
  const table = COLLECTIONS[key];
  const before = baseline?.collections?.[key] || new Map();
  const after = collectionMap(desiredRecords);

  for (const [id, record] of after) {
    if (before.get(id) === record) continue;
    await client.query(
      `INSERT INTO ${tableName(table)} (id, record)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record, updated_at = now()`,
      [id, record]
    );
  }

  for (const id of before.keys()) {
    if (after.has(id)) continue;
    await client.query(`DELETE FROM ${tableName(table)} WHERE id = $1`, [id]);
  }
}

async function writePostgresDb(db) {
  await ensurePostgres();
  const baseline = db?.[BASELINE];
  const next = {
    ...db,
    meta: {
      ...(db.meta || {}),
      appName: "Power Tool",
      version: 11,
      updatedAt: new Date().toISOString()
    }
  };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const key of Object.keys(COLLECTIONS)) {
      await writeCollectionChanges(client, key, next[key], baseline);
    }
    if (!baseline || serialized(next.meta) !== baseline.meta) {
      await insertSingleton(client, "power_tool_meta", next.meta);
    }

    if (!baseline) {
      await insertSingleton(client, "power_tool_usage", next.usage || emptyUsage());
    } else if (serialized(next.usage || {}) !== serialized(baseline.usage || {})) {
      const currentResult = await client.query(
        `SELECT record FROM ${tableName("power_tool_usage")}
         WHERE singleton = true
         FOR UPDATE`
      );
      const merged = mergeUsage(
        currentResult.rows[0]?.record || emptyUsage(),
        baseline.usage,
        next.usage
      );
      await insertSingleton(client, "power_tool_usage", merged);
      next.usage = merged;
    }
    await client.query("COMMIT");
    return attachBaseline(next);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeDataStore() {
  if (POSTGRES_ENABLED) return ensurePostgres();
  return jsonStore.readDb();
}

export async function readDb() {
  if (POSTGRES_ENABLED) return readPostgresDb();
  return jsonStore.readDb();
}

export async function writeDb(db) {
  if (POSTGRES_ENABLED) return writePostgresDb(db);
  return jsonStore.writeDb(db);
}

function limitedLogValue(value, maximum, fallback = "") {
  const normalized = String(value ?? "").trim();
  return (normalized || fallback).slice(0, maximum);
}

export async function recordPowerToolLog(entry = {}) {
  if (!POSTGRES_ENABLED) {
    return { stored: false, inserted: false, provider: "json" };
  }

  await ensurePostgres();
  const eventType = limitedLogValue(entry.eventType, 60);
  const eventKey = limitedLogValue(entry.eventKey, 360);
  if (!eventType || !eventKey) {
    throw new Error("Power Tool log eventType and eventKey are required.");
  }

  const values = [
    eventType,
    eventKey,
    limitedLogValue(entry.sessionId, 120),
    limitedLogValue(entry.ipAddress, 120, "unknown"),
    limitedLogValue(entry.requestPath, 500),
    limitedLogValue(entry.requestMethod, 20),
    Number.isInteger(Number(entry.responseStatus)) ? Number(entry.responseStatus) : 200,
    limitedLogValue(entry.userAgent, 1000),
    limitedLogValue(entry.targetId, 180),
    serialized(entry.details && typeof entry.details === "object" ? entry.details : {})
  ];

  const client = await getPool().connect();
  try {
    const result = await client.query(
      `INSERT INTO ${powerToolLogsTableName()} (
         event_type, event_key, session_id, ip_address, request_path,
         request_method, response_status, user_agent, target_id, details
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (event_type, event_key) DO UPDATE
       SET session_id = EXCLUDED.session_id,
           ip_address = EXCLUDED.ip_address,
           request_path = CASE
             WHEN EXCLUDED.request_path = '' THEN "PowerTool-logs".request_path
             ELSE EXCLUDED.request_path
           END,
           request_method = CASE
             WHEN EXCLUDED.request_method = '' THEN "PowerTool-logs".request_method
             ELSE EXCLUDED.request_method
           END,
           response_status = EXCLUDED.response_status,
           user_agent = CASE
             WHEN EXCLUDED.user_agent = '' THEN "PowerTool-logs".user_agent
             ELSE EXCLUDED.user_agent
           END,
           target_id = CASE
             WHEN EXCLUDED.target_id = '' THEN "PowerTool-logs".target_id
             ELSE EXCLUDED.target_id
           END,
           details = EXCLUDED.details,
           last_seen_at = now()
       RETURNING id`,
      values
    );
    return { stored: true, id: result.rows[0]?.id };
  } finally {
    client.release();
  }
}

export async function checkDb() {
  if (!POSTGRES_ENABLED) {
    await jsonStore.readDb();
    return { ok: true, provider: "json" };
  }
  await ensurePostgres();
  await getPool().query("SELECT 1");
  return { ok: true, provider: "postgresql", schema: schemaName() };
}

export async function closeDb() {
  if (pool) {
    const currentPool = pool;
    pool = undefined;
    ensurePromise = undefined;
    await currentPool.end();
  }
}

export function getDbPath() {
  if (!POSTGRES_ENABLED) return jsonStore.getDbPath();
  return `PostgreSQL (schema ${schemaName()})`;
}
