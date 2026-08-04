import assert from "node:assert/strict";
import "dotenv/config";

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required in .env for the smoke test.`);
  return value;
}

const baseUrl = requiredEnvironment("TEST_BASE_URL").replace(/\/$/, "");
const adminUsername = requiredEnvironment("ADMIN_USERNAME");
const adminPassword = requiredEnvironment("ADMIN_PASSWORD");
const reviewerUsername = requiredEnvironment("INITIAL_REVIEWER_USERNAME");
const reviewerPassword = requiredEnvironment("INITIAL_REVIEWER_PASSWORD");
const addedReviewerPassword = "smoke-test-reviewer-password";
const tinyImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=";

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

const categoriesResult = await request("/categories");
assert.equal(categoriesResult.response.status, 200);
assert.deepEqual(categoriesResult.body.map((category) => category.id), ["cat-elc", "cat-portable-tool"]);
assert.deepEqual(categoriesResult.body.map((category) => category.name), ["ELC", "Portable Tools"]);
const elc = categoriesResult.body[0];
const portable = categoriesResult.body[1];
assert.deepEqual(elc.detailFields.map((field) => field.label), [
  "Module Type",
  "Search Type",
  "From Date",
  "To Date",
  "Machine",
  "Power Supply (N/A if none)",
  "Vendor"
]);
assert.deepEqual(elc.reviewQuestions, []);
assert.deepEqual(portable.detailFields, []);

const reviewerLogin = await request("/auth/login", {
  method: "POST",
  body: JSON.stringify({ username: reviewerUsername, password: reviewerPassword })
});
assert.equal(reviewerLogin.response.status, 200);
assert.equal(reviewerLogin.body.role, "reviewer");

const adminLogin = await request("/auth/login", {
  method: "POST",
  body: JSON.stringify({ username: adminUsername, password: adminPassword })
});
assert.equal(adminLogin.response.status, 200);
assert.equal(adminLogin.body.role, "admin");

const staffAccounts = await request(`/staff/accounts?adminUsername=${encodeURIComponent(adminUsername)}`);
assert.equal(staffAccounts.response.status, 200);
assert.deepEqual(staffAccounts.body.map((account) => account.role), ["admin", "reviewer"]);
assert.equal(staffAccounts.body[0].username, adminUsername);
const rejectedAccountCreation = await request("/staff/reviewers", {
  method: "POST",
  body: JSON.stringify({
    adminUsername,
    adminPassword: "wrong-password",
    username: "blocked.reviewer",
    password: addedReviewerPassword
  })
});
assert.equal(rejectedAccountCreation.response.status, 403);
const addedReviewer = await request("/staff/reviewers", {
  method: "POST",
  body: JSON.stringify({
    adminUsername,
    adminPassword,
    username: "reviewer.two",
    password: addedReviewerPassword
  })
});
assert.equal(addedReviewer.response.status, 201);
assert.equal(addedReviewer.body.displayName, "reviewer.two");
assert.equal(Object.prototype.hasOwnProperty.call(addedReviewer.body, "password"), false);
const secondReviewerLogin = await request("/auth/login", {
  method: "POST",
  body: JSON.stringify({ username: "reviewer.two", password: addedReviewerPassword })
});
assert.equal(secondReviewerLogin.response.status, 200);

const reviewQuestions = [
  { id: "review-guard", label: "Is the guard complete?", type: "yesno", required: true, options: [] },
  { id: "review-result", label: "Inspection result", type: "radio", required: true, options: ["Pass", "Fail"] }
];
const builderResult = await request(`/categories/${elc.id}`, {
  method: "PUT",
  body: JSON.stringify({ ...elc, reviewQuestions })
});
assert.equal(builderResult.response.status, 200);
assert.deepEqual(builderResult.body.reviewQuestions[1].options, ["Pass", "Fail"]);

const invalidResult = await request("/requests", {
  method: "POST",
  body: JSON.stringify({ itemName: "Test ELC", site: "Engineering", categoryId: elc.id, detailValues: {} })
});
assert.equal(invalidResult.response.status, 400);

const createResult = await request("/requests", {
  method: "POST",
  body: JSON.stringify({
    itemName: "Test ELC",
    site: "Engineering",
    submittedBy: "Smoke Test",
    categoryId: elc.id,
    toolImages: [tinyImage, tinyImage],
    detailValues: {
      moduleType: "Electrical",
      searchType: "Inspection",
      fromDate: "2026-07-23",
      toDate: "2026-12-31",
      machine: "Test Machine",
      powerSupply: "230 VAC",
      vendor: "Test Vendor"
    }
  })
});
assert.equal(createResult.response.status, 201);
assert.match(createResult.body.itemCode, /^PT-/);
assert.equal(createResult.body.toolImages.length, 2);
assert.equal(createResult.body.reviewQuestionsSnapshot.length, 2);
assert.deepEqual(createResult.body.reviewAnswers, {});
const requestId = createResult.body.id;

const requestDetails = await request(`/requests/${requestId}`);
assert.equal(requestDetails.response.status, 200);
assert.equal(requestDetails.body.itemName, "Test ELC");
assert.equal(requestDetails.body.toolImages.length, 2);

const missingReview = await request(`/requests/${requestId}/approve`, {
  method: "POST",
  body: JSON.stringify({ role: "reviewer", approvedBy: "Reviewer" })
});
assert.equal(missingReview.response.status, 400);

const approval = await request(`/requests/${requestId}/approve`, {
  method: "POST",
  body: JSON.stringify({
    role: "reviewer",
    approvedBy: "Reviewer",
    reviewNote: "Guard and inspection result verified.",
    reviewAnswers: { "review-guard": "Yes", "review-result": "Pass" }
  })
});
assert.equal(approval.response.status, 201);
assert.equal(approval.body.complete, true);
assert.equal(approval.body.item.expiresAt, "2026-12-31");
assert.equal(approval.body.item.reviewedRole, "reviewer");

const qrId = approval.body.item.qrId;
const itemResult = await request(`/items/qr/${encodeURIComponent(qrId)}`);
assert.equal(itemResult.response.status, 200);
assert.equal(itemResult.body.toolType, "ELC");
assert.equal(itemResult.body.detailValues.powerSupply, "230 VAC");
assert.equal(itemResult.body.detailsSnapshot.length, 7);
assert.equal(itemResult.body.reviewAnswers["review-result"], "Pass");
assert.equal(itemResult.body.toolImages.length, 2);
assert.equal(itemResult.body.reviewedBy, "Reviewer");
assert.equal(itemResult.body.reviewNote, "Guard and inspection result verified.");

const portableBuilder = await request(`/categories/${portable.id}`, {
  method: "PUT",
  body: JSON.stringify({
    ...portable,
    detailFields: [{ id: "portable-vendor", label: "Vendor", type: "text", required: true, options: [] }],
    reviewQuestions: [{ id: "portable-safe", label: "Safe to use?", type: "yesno", required: true, options: [] }]
  })
});
assert.equal(portableBuilder.response.status, 200);

const portableResult = await request("/requests", {
  method: "POST",
  body: JSON.stringify({
    itemName: "Portable Drill",
    site: "Savoury",
    submittedBy: "Smoke Test",
    categoryId: portable.id,
    detailValues: { "portable-vendor": "Vendor A" }
  })
});
assert.equal(portableResult.response.status, 201);

const rejection = await request(`/requests/${portableResult.body.id}/reject`, {
  method: "POST",
  body: JSON.stringify({
    role: "admin",
    rejectedBy: "Administrator",
    reviewAnswers: { "portable-safe": "No" },
    reviewNote: "Cable damaged"
  })
});
assert.equal(rejection.response.status, 200);
assert.equal(rejection.body.status, "rejected");
assert.equal(rejection.body.rejectedRole, "admin");

const archivedRejection = await request(`/requests/${portableResult.body.id}/archive`, {
  method: "POST",
  body: JSON.stringify({ archiveNote: "Test archive" })
});
assert.ok(archivedRejection.body.archivedAt);
const restoredRejection = await request(`/requests/${portableResult.body.id}/restore`, {
  method: "POST",
  body: JSON.stringify({})
});
assert.equal(restoredRejection.body.archivedAt, null);

const automaticBuilder = await request(`/categories/${portable.id}`, {
  method: "PUT",
  body: JSON.stringify({
    ...portableBuilder.body,
    reviewQuestions: [{
      id: "portable-auto-safe",
      label: "Safe to use?",
      type: "yesno",
      required: true,
      options: [],
      autoDecision: {
        enabled: true,
        outcomes: { Yes: "approved", No: "rejected" }
      }
    }]
  })
});
assert.equal(automaticBuilder.response.status, 200);
assert.equal(automaticBuilder.body.reviewQuestions[0].autoDecision.enabled, true);

const autoRejectedRequest = await request("/requests", {
  method: "POST",
  body: JSON.stringify({
    itemName: "Unsafe Auto Drill",
    site: "Savoury",
    submittedBy: "Smoke Test",
    categoryId: portable.id,
    detailValues: { "portable-vendor": "Vendor B" }
  })
});
const blockedManualDecision = await request(`/requests/${autoRejectedRequest.body.id}/reject`, {
  method: "POST",
  body: JSON.stringify({
    role: "reviewer",
    rejectedBy: "Reviewer",
    reviewAnswers: { "portable-auto-safe": "No" }
  })
});
assert.equal(blockedManualDecision.response.status, 409);
const autoRejection = await request(`/requests/${autoRejectedRequest.body.id}/review`, {
  method: "POST",
  body: JSON.stringify({
    role: "reviewer",
    reviewedBy: "Reviewer",
    reviewAnswers: { "portable-auto-safe": "No" }
  })
});
assert.equal(autoRejection.response.status, 200);
assert.equal(autoRejection.body.decision, "rejected");
assert.equal(autoRejection.body.request.reviewDecisionSource, "automatic-question");

const autoApprovedRequest = await request("/requests", {
  method: "POST",
  body: JSON.stringify({
    itemName: "Safe Auto Drill",
    site: "Savoury",
    submittedBy: "Smoke Test",
    categoryId: portable.id,
    detailValues: { "portable-vendor": "Vendor C" }
  })
});
const autoApproval = await request(`/requests/${autoApprovedRequest.body.id}/review`, {
  method: "POST",
  body: JSON.stringify({
    role: "admin",
    reviewedBy: "Administrator",
    expiresAt: "2030-12-31",
    reviewAnswers: { "portable-auto-safe": "Yes" }
  })
});
assert.equal(autoApproval.response.status, 201);
assert.equal(autoApproval.body.decision, "approved");
assert.equal(autoApproval.body.item.reviewDecisionSource, "automatic-question");

const approvedSearch = await request(`/items?status=valid&search=${encodeURIComponent(qrId)}`);
assert.equal(approvedSearch.response.status, 200);
assert.equal(approvedSearch.body.length, 1);

const expiredUpdate = await request(`/items/${approval.body.item.id}`, {
  method: "PATCH",
  body: JSON.stringify({ expiresAt: "2020-01-01" })
});
assert.equal(expiredUpdate.body.validity.status, "expired");
const renewedUpdate = await request(`/items/${approval.body.item.id}/renew`, {
  method: "POST",
  body: JSON.stringify({
    expiresAt: "2030-12-31",
    role: "reviewer",
    renewedBy: "Second Reviewer",
    reviewNote: "Renewal inspection completed.",
    reviewAnswers: { "review-guard": "Yes", "review-result": "Pass" }
  })
});
assert.equal(renewedUpdate.response.status, 200);
assert.equal(renewedUpdate.body.validity.status, "valid");
assert.equal(renewedUpdate.body.reviewedBy, "Second Reviewer");
assert.equal(renewedUpdate.body.renewalHistory.length, 1);
assert.equal(renewedUpdate.body.renewalHistory[0].previousExpiresAt, "2020-01-01");
await request(`/items/${approval.body.item.id}`, {
  method: "PATCH",
  body: JSON.stringify({ expiresAt: "2020-01-01" })
});
const archivedUpdate = await request(`/items/${approval.body.item.id}/archive`, {
  method: "POST",
  body: JSON.stringify({ archiveNote: "Smoke archive" })
});
assert.equal(archivedUpdate.body.validity.status, "archived");
await request(`/items/${approval.body.item.id}/restore`, { method: "POST", body: JSON.stringify({}) });

const usageHeaders = { "x-forwarded-for": "192.0.2.10" };
for (let index = 0; index < 2; index += 1) {
  const visit = await request("/usage/visit", { method: "POST", headers: usageHeaders, body: JSON.stringify({ sessionId: "smoke-session", path: "/" }) });
  assert.equal(visit.body.counted, index === 0);
}
const sessionLogin = await request("/auth/login", {
  method: "POST",
  headers: usageHeaders,
  body: JSON.stringify({
    username: reviewerUsername,
    password: reviewerPassword,
    sessionId: "smoke-session",
    path: "/reviewer"
  })
});
assert.equal(sessionLogin.response.status, 200);
const sessionEvent = await request("/usage/event", {
  method: "POST",
  headers: usageHeaders,
  body: JSON.stringify({
    type: "qr_open",
    targetId: qrId,
    sessionId: "smoke-session",
    path: `/item/${qrId}`
  })
});
assert.equal(sessionEvent.response.status, 200);
const sessionLogout = await request("/usage/session/logout", {
  method: "POST",
  headers: usageHeaders,
  body: JSON.stringify({ sessionId: "smoke-session", path: "/reviewer" })
});
assert.equal(sessionLogout.response.status, 200);
const sessionEnd = await request("/usage/session/end", {
  method: "POST",
  headers: usageHeaders,
  body: JSON.stringify({ sessionId: "smoke-session", path: "/" })
});
assert.equal(sessionEnd.response.status, 200);
const removedUsagePage = await request("/usage");
assert.equal(removedUsagePage.response.status, 404);

const removedReviewer = await request(`/staff/reviewers/${addedReviewer.body.id}`, {
  method: "DELETE",
  body: JSON.stringify({ adminUsername, adminPassword })
});
assert.equal(removedReviewer.response.status, 200);

console.log("Smoke test passed: shared Reviewer/Admin login, protected account changes, manual and automatic review decisions, approval attribution, expired renewal, full-page records, QR records, archive/restore, search, and session-based visitor usage.");
