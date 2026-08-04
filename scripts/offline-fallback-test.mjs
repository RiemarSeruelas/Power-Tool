import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DataType, newDb } from "pg-mem";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "power-tool-fallback-"));
const memory = newDb();
memory.public.registerFunction({
  name: "hashtext",
  args: [DataType.text],
  returns: DataType.integer,
  implementation: () => 1
});
memory.public.registerFunction({
  name: "pg_advisory_xact_lock",
  args: [DataType.integer],
  returns: DataType.integer,
  implementation: () => 1
});

const adapter = memory.adapters.createPg();
let postgresOnline = false;

function refusedConnection() {
  const error = new Error("connect ECONNREFUSED test-postgres:5432");
  error.code = "ECONNREFUSED";
  return error;
}

class SwitchingPool {
  constructor(options) {
    this.inner = new adapter.Pool(options);
  }

  on(...args) {
    return this.inner.on(...args);
  }

  async connect() {
    if (!postgresOnline) throw refusedConnection();
    return this.inner.connect();
  }

  async query(...args) {
    if (!postgresOnline) throw refusedConnection();
    return this.inner.query(...args);
  }

  async end() {
    return this.inner.end();
  }
}

globalThis.__POWER_TOOL_POSTGRES_POOL__ = SwitchingPool;
process.env.POSTGRES_ENABLED = "true";
process.env.POSTGRES_HOST = "test-postgres";
process.env.POSTGRES_PORT = "5432";
process.env.POSTGRES_DB = "mydatabase";
process.env.POSTGRES_USER = "myuser";
process.env.POSTGRES_PASSWORD = "not-logged";
process.env.POSTGRES_SCHEMA = "app";
process.env.POWER_TOOL_DATA_DIR = dataDir;
process.env.ADMIN_USERNAME = "test-admin";
process.env.ADMIN_PASSWORD = "offline-admin-password";
process.env.INITIAL_REVIEWER_USERNAME = "test-reviewer";
process.env.INITIAL_REVIEWER_PASSWORD = "offline-reviewer-password";

const {
  closeDb,
  getDataStoreState,
  initializeDataStore,
  readDb,
  reconnectPostgres,
  writeDb
} = await import("../server/dataStore.js");

await initializeDataStore();
assert.equal(getDataStoreState().provider, "json");
assert.equal(getDataStoreState().fallback, true);

const firstOfflineDb = await readDb();
firstOfflineDb.requests.push({
  id: "offline-request-one",
  itemName: "Offline Request One",
  status: "pending"
});
firstOfflineDb.usage.totalVisits = 1;
firstOfflineDb.usage.sessions["offline-session-one"] = {
  sessionId: "offline-session-one",
  ip: "10.0.0.8",
  createdAt: "2026-08-04T01:00:00.000Z",
  lastSeenAt: "2026-08-04T01:01:00.000Z",
  firstPath: "/",
  path: "/register",
  visitorType: "visitor",
  status: "active",
  deviceType: "Desktop",
  browser: "Microsoft Edge",
  operatingSystem: "Windows"
};
firstOfflineDb.usage.ips["10.0.0.8"] = {
  ip: "10.0.0.8",
  visits: 1,
  qrOpens: 0,
  checklistViews: 0,
  firstSeenAt: "2026-08-04T01:00:00.000Z",
  lastSeenAt: "2026-08-04T01:01:00.000Z",
  lastPath: "/register"
};
await writeDb(firstOfflineDb);

await assert.rejects(reconnectPostgres(), /ECONNREFUSED/);
assert.equal(getDataStoreState().provider, "json");

postgresOnline = true;
await reconnectPostgres();
assert.equal(getDataStoreState().provider, "postgresql");
let recoveredDb = await readDb();
assert.equal(recoveredDb.requests.some((entry) => entry.id === "offline-request-one"), true);
assert.equal(recoveredDb.usage.totalVisits, 1);

let storedLogs = memory.public.many('SELECT * FROM app."PowerTool-logs" ORDER BY id');
assert.equal(storedLogs.length, 1);
assert.equal(storedLogs[0].session_id, "offline-session-one");

postgresOnline = false;
recoveredDb = await readDb();
assert.equal(getDataStoreState().provider, "json");
recoveredDb.requests.find((entry) => entry.id === "offline-request-one").itemName = "Updated During Outage";
recoveredDb.requests.push({
  id: "offline-request-two",
  itemName: "Offline Request Two",
  status: "pending"
});
await writeDb(recoveredDb);

postgresOnline = true;
await reconnectPostgres();
const afterSecondRecovery = await readDb();
assert.equal(
  afterSecondRecovery.requests.find((entry) => entry.id === "offline-request-one").itemName,
  "Updated During Outage"
);
assert.equal(afterSecondRecovery.requests.some((entry) => entry.id === "offline-request-two"), true);
assert.equal(getDataStoreState().provider, "postgresql");

storedLogs = memory.public.many('SELECT * FROM app."PowerTool-logs" ORDER BY id');
assert.equal(storedLogs.length, 1);

await closeDb();
delete globalThis.__POWER_TOOL_POSTGRES_POOL__;
await fs.rm(dataDir, { recursive: true, force: true });

console.log("Offline fallback test passed: startup, local writes, session recovery, disconnect fallback, and PostgreSQL resynchronization are preserved.");
