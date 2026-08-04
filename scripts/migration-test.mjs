import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "power-tool-migration-"));
process.env.POWER_TOOL_DATA_DIR = dataDir;
process.env.POSTGRES_ENABLED = "false";
process.env.ADMIN_USERNAME = "test-admin";
process.env.ADMIN_PASSWORD = "migration-admin-password";
process.env.INITIAL_REVIEWER_USERNAME = "test-reviewer";
process.env.INITIAL_REVIEWER_PASSWORD = "migration-reviewer-password";

const oldDb = {
  meta: { appName: "Power Tool", version: 5, updatedAt: "2026-07-23T00:00:00.000Z" },
  categories: [
    {
      id: "cat-elc",
      name: "ELC",
      description: "",
      fields: [{ id: "old-review", label: "Old review question", type: "yesno", required: true, options: [] }],
      createdAt: "2026-07-23T00:00:00.000Z"
    },
    { id: "cat-portable-tool", name: "Portable Tools", description: "", fields: [], createdAt: "2026-07-23T00:00:00.000Z" }
  ],
  legacyCategories: [],
  adminAccount: { id: "admin", username: "admin", password: "5678", displayName: "Existing Admin" },
  requests: [{
    id: "request-keep",
    status: "pending",
    categoryId: "cat-elc",
    powerValues: { vendor: "Keep Vendor" },
    powerFieldsSnapshot: [{ id: "vendor", label: "Vendor", type: "text" }],
    fieldsSnapshot: [{ id: "old-review", label: "Old review question", type: "yesno" }],
    values: {},
    toolImage: "data:image/png;base64,LEGACYREQUEST"
  }],
  items: [{ id: "item-keep", qrId: "QR-KEEP", values: { "old-review": "Yes" }, toolImage: "data:image/png;base64,LEGACYITEM" }],
  usage: { totalVisits: 4, totalQrOpens: 2, totalChecklistViews: 1, ips: {}, sessions: {}, events: {} }
};

await fs.writeFile(path.join(dataDir, "db.json"), JSON.stringify(oldDb, null, 2));
const { readDb, writeDb } = await import("../server/dataStore.js");
const { isPasswordHash, verifyPassword } = await import("../server/passwords.js");
const migrated = await readDb();

assert.equal(migrated.meta.version, 11);
assert.equal(migrated.staffAccounts.find((account) => account.role === "admin").username, "test-admin");
assert.equal(verifyPassword("migration-admin-password", migrated.staffAccounts.find((account) => account.role === "admin").password), true);
assert.equal(migrated.staffAccounts.find((account) => account.role === "reviewer").username, "test-reviewer");
assert.equal(verifyPassword("migration-reviewer-password", migrated.staffAccounts.find((account) => account.role === "reviewer").password), true);
assert.equal(migrated.staffAccounts.every((account) => isPasswordHash(account.password)), true);
assert.equal(Object.prototype.hasOwnProperty.call(migrated, "adminAccount"), false);
assert.equal(migrated.categories[0].reviewQuestions[0].label, "Old review question");
assert.equal(migrated.categories[0].detailFields.length, 7);
assert.equal(migrated.requests[0].id, "request-keep");
assert.equal(migrated.requests[0].detailValues.vendor, "Keep Vendor");
assert.deepEqual(migrated.requests[0].approvalFlow, ["reviewer", "admin"]);
assert.equal(migrated.requests[0].currentApprovalRole, "reviewer-or-admin");
assert.deepEqual(migrated.requests[0].toolImages, ["data:image/png;base64,LEGACYREQUEST"]);
assert.equal(migrated.items[0].reviewAnswers["old-review"], "Yes");
assert.deepEqual(migrated.items[0].toolImages, ["data:image/png;base64,LEGACYITEM"]);
assert.deepEqual(migrated.items[0].renewalHistory, []);
assert.equal(migrated.usage.totalVisits, 4);

const versionEight = structuredClone(migrated);
versionEight.meta.version = 8;
versionEight.categories[0].detailFields.push({
  id: "custom-detail",
  label: "My saved detail",
  type: "text",
  required: false,
  placeholder: "",
  options: []
});
versionEight.categories[0].reviewQuestions.push({
  id: "custom-question",
  label: "My saved review question",
  type: "yesno",
  required: true,
  placeholder: "",
  options: [],
  autoDecision: {
    enabled: true,
    outcomes: { Yes: "approved", No: "rejected" }
  }
});
versionEight.staffAccounts.find((account) => account.role === "admin").password = "9876";
versionEight.staffAccounts.push({
  id: "reviewer-extra",
  username: "reviewer.two",
  password: "5678",
  role: "reviewer",
  displayName: "Second Reviewer",
  createdAt: "2026-07-23T01:00:00.000Z"
});
await fs.writeFile(path.join(dataDir, "db.json"), JSON.stringify(versionEight, null, 2));
const upgradedVersionEight = await readDb();
assert.equal(upgradedVersionEight.meta.version, 11);
assert.equal(upgradedVersionEight.categories[0].detailFields.at(-1).label, "My saved detail");
assert.equal(upgradedVersionEight.categories[0].reviewQuestions.at(-1).label, "My saved review question");
assert.deepEqual(upgradedVersionEight.categories[0].reviewQuestions.at(-1).autoDecision, {
  enabled: true,
  outcomes: { Yes: "approved", No: "rejected" }
});
assert.equal(verifyPassword("migration-admin-password", upgradedVersionEight.staffAccounts.find((account) => account.role === "admin").password), true);
assert.equal(upgradedVersionEight.staffAccounts.filter((account) => account.role === "reviewer").length, 2);
assert.equal(upgradedVersionEight.staffAccounts.find((account) => account.username === "reviewer.two").displayName, "reviewer.two");
assert.equal(verifyPassword("5678", upgradedVersionEight.staffAccounts.find((account) => account.username === "reviewer.two").password), true);

upgradedVersionEight.staffAccounts.find((account) => account.role === "admin").password = "2468";
await writeDb(upgradedVersionEight);
const manuallyEdited = await readDb();
assert.equal(verifyPassword("2468", manuallyEdited.staffAccounts.find((account) => account.role === "admin").password), true);
assert.equal(isPasswordHash(manuallyEdited.staffAccounts.find((account) => account.role === "admin").password), true);

console.log("Migration test passed: v11 preserves Builder content, automatic decisions, records, multiple Reviewer accounts, renewal history, legacy images, and protected Admin credentials.");
