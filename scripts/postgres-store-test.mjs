import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DataType, newDb } from "pg-mem";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "power-tool-postgres-"));
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
globalThis.__POWER_TOOL_POSTGRES_POOL__ = adapter.Pool;
process.env.POSTGRES_ENABLED = "true";
process.env.POSTGRES_HOST = "memory";
process.env.POSTGRES_PORT = "5432";
process.env.POSTGRES_DB = "mydatabase";
process.env.POSTGRES_USER = "myuser";
process.env.POSTGRES_PASSWORD = "not-logged";
process.env.POSTGRES_SCHEMA = "app";
process.env.POWER_TOOL_DATA_DIR = dataDir;
process.env.ADMIN_USERNAME = "test-admin";
process.env.ADMIN_PASSWORD = "postgres-admin-password";
process.env.INITIAL_REVIEWER_USERNAME = "test-reviewer";
process.env.INITIAL_REVIEWER_PASSWORD = "postgres-reviewer-password";

const legacyDb = {
  meta: { appName: "Power Tool", version: 10, updatedAt: "2026-07-24T00:00:00.000Z" },
  categories: [
    {
      id: "cat-elc",
      name: "ELC",
      description: "",
      detailFields: [{ id: "vendor", label: "Vendor", type: "text", required: true, placeholder: "", options: [] }],
      reviewQuestions: [],
      createdAt: "2026-07-24T00:00:00.000Z"
    },
    {
      id: "cat-portable-tool",
      name: "Portable Tools",
      description: "",
      detailFields: [],
      reviewQuestions: [],
      createdAt: "2026-07-24T00:00:00.000Z"
    }
  ],
  legacyCategories: [],
  staffAccounts: [
    { id: "admin", username: "test-admin", password: "legacy-admin-password", role: "admin", displayName: "test-admin", active: true },
    { id: "reviewer", username: "test-reviewer", password: "legacy-reviewer-password", role: "reviewer", displayName: "test-reviewer", active: true }
  ],
  requests: [{ id: "request-imported", status: "pending", itemName: "Imported request" }],
  items: [{ id: "item-imported", qrId: "QR-IMPORTED", itemName: "Imported item", renewalHistory: [] }],
  usage: {
    totalVisits: 4,
    totalQrOpens: 2,
    totalChecklistViews: 1,
    ips: {},
    sessions: {},
    events: {}
  }
};
await fs.writeFile(path.join(dataDir, "db.json"), JSON.stringify(legacyDb, null, 2));

const {
  checkDb,
  closeDb,
  getDbPath,
  initializeDataStore,
  reconnectPostgres,
  recordPowerToolLog,
  readDb,
  writeDb
} = await import("../server/dataStore.js");
const { isPasswordHash, verifyPassword } = await import("../server/passwords.js");

await initializeDataStore();
await reconnectPostgres();
const imported = await readDb();
assert.equal(imported.requests[0].id, "request-imported");
assert.equal(imported.items[0].qrId, "QR-IMPORTED");
assert.equal(imported.staffAccounts.length, 2);
assert.equal(imported.staffAccounts.every((account) => isPasswordHash(account.password)), true);
assert.equal(verifyPassword("legacy-admin-password", imported.staffAccounts.find((account) => account.role === "admin").password), true);
assert.equal(verifyPassword("legacy-reviewer-password", imported.staffAccounts.find((account) => account.role === "reviewer").password), true);
assert.equal(imported.usage.totalVisits, 4);
assert.equal((await checkDb()).provider, "postgresql");
assert.equal(getDbPath().includes("not-logged"), false);

const writerA = await readDb();
const writerB = await readDb();
writerA.requests.push({ id: "request-a", status: "pending", itemName: "Concurrent A" });
writerB.requests.push({ id: "request-b", status: "pending", itemName: "Concurrent B" });
await Promise.all([writeDb(writerA), writeDb(writerB)]);
const afterConcurrentRecords = await readDb();
assert.ok(afterConcurrentRecords.requests.some((record) => record.id === "request-a"));
assert.ok(afterConcurrentRecords.requests.some((record) => record.id === "request-b"));

function addVisit(snapshot, sessionId, ip) {
  snapshot.usage.totalVisits += 1;
  snapshot.usage.sessions[sessionId] = {
    sessionId,
    ip,
    createdAt: "2026-07-24T01:00:00.000Z",
    lastSeenAt: "2026-07-24T01:00:00.000Z",
    path: "/"
  };
  snapshot.usage.ips[ip] = {
    ip,
    visits: 1,
    qrOpens: 0,
    checklistViews: 0,
    firstSeenAt: "2026-07-24T01:00:00.000Z",
    lastSeenAt: "2026-07-24T01:00:00.000Z",
    lastPath: "/"
  };
}

const duplicateVisitA = await readDb();
const duplicateVisitB = await readDb();
addVisit(duplicateVisitA, "same-session", "10.0.0.8");
addVisit(duplicateVisitB, "same-session", "10.0.0.8");
await Promise.all([writeDb(duplicateVisitA), writeDb(duplicateVisitB)]);
const afterDuplicateVisit = await readDb();
assert.equal(afterDuplicateVisit.usage.totalVisits, 5);
assert.equal(afterDuplicateVisit.usage.ips["10.0.0.8"].visits, 1);
assert.equal(Object.keys(afterDuplicateVisit.usage.sessions).length, 1);

const firstLog = await recordPowerToolLog({
  eventType: "visitor_session",
  eventKey: "same-session",
  sessionId: "same-session",
  ipAddress: "10.0.0.8",
  requestPath: "/",
  requestMethod: "POST",
  responseStatus: 200,
  userAgent: "PostgreSQL store test",
  details: {
    visitorType: "visitor",
    accountUsername: "",
    sessionStatus: "active",
    deviceType: "Desktop",
    browser: "Google Chrome",
    operatingSystem: "Windows"
  }
});
const repeatedLog = await recordPowerToolLog({
  eventType: "visitor_session",
  eventKey: "same-session",
  sessionId: "same-session",
  ipAddress: "10.0.0.8",
  requestPath: "/follow-up",
  requestMethod: "POST",
  responseStatus: 200,
  userAgent: "PostgreSQL store test",
  details: {
    visitorType: "reviewer",
    accountUsername: "test-reviewer",
    accountDisplayName: "Test Reviewer",
    authenticated: false,
    loginCount: 1,
    sessionStatus: "ended",
    sessionEndedAt: "2026-07-24T02:00:00.000Z",
    deviceType: "Desktop",
    browser: "Google Chrome",
    operatingSystem: "Windows"
  }
});
assert.equal(firstLog.stored, true);
assert.equal(repeatedLog.stored, true);
const storedLogs = memory.public.many('SELECT * FROM app."PowerTool-logs" ORDER BY id');
assert.equal(storedLogs.length, 1);
assert.equal(storedLogs[0].event_type, "visitor_session");
assert.equal(storedLogs[0].request_path, "/follow-up");
assert.equal(storedLogs[0].details.accountUsername, "test-reviewer");
assert.equal(storedLogs[0].details.sessionStatus, "ended");

const remover = await readDb();
const creator = await readDb();
remover.staffAccounts = remover.staffAccounts.filter((account) => account.id !== "reviewer");
creator.staffAccounts.push({
  id: "reviewer-new",
  username: "reviewer.new",
  password: "5678",
  role: "reviewer",
  displayName: "reviewer.new",
  active: true
});
await Promise.all([writeDb(remover), writeDb(creator)]);
const afterAccountChanges = await readDb();
assert.equal(afterAccountChanges.staffAccounts.some((account) => account.id === "reviewer"), false);
assert.equal(afterAccountChanges.staffAccounts.some((account) => account.id === "reviewer-new"), true);
assert.equal(afterAccountChanges.staffAccounts.some((account) => account.id === "admin"), true);

await closeDb();
delete globalThis.__POWER_TOOL_POSTGRES_POOL__;
console.log('PostgreSQL store test passed: JSON import, normalized persistence, pooled health check, concurrent inserts, deduplicated usage, one-row visitor sessions in app."PowerTool-logs", and targeted deletion are preserved.');
