// Tests for scripts/issue-consumer.mjs
//
// Run with: node --test scripts/issue-consumer.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

// Point the consumer at fake endpoints and a no-op "CLI" (`true` exits 0
// immediately) *before* importing the module, since these are read once
// at import time.
process.env.DOCKYARD_API = "http://api.invalid";
process.env.DEEPSEEK_CMD = "true";

// The consumer also reads EC2_API/EC2_HOST at import time to decide whether
// to push updates to a second (EC2) API base. Explicitly clear these so the
// single-base tests below are deterministic regardless of the ambient shell
// environment (e.g. a dev machine with EC2_API exported globally).
delete process.env.EC2_API;
delete process.env.EC2_HOST;

const {
  updateIssueOnServer,
  consumeOne,
  setAuthHeaderForTest,
} = await import("./issue-consumer.mjs");

setAuthHeaderForTest("Bearer test-token");

function mockFetchSequence(responses) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected fetch call to ${url}`);
    return next;
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("updateIssueOnServer PATCHes the issue with resolved status", async () => {
  const mock = mockFetchSequence([fakeResponse(200, { ok: true })]);
  try {
    await updateIssueOnServer(
      { id: "issue-1", summary: "Something broke" },
      "resolved",
      "Fixed the thing.",
    );
  } finally {
    mock.restore();
  }

  assert.equal(mock.calls.length, 1);
  const [call] = mock.calls;
  assert.equal(call.url, "http://api.invalid/api/assistant/issues/issue-1");
  assert.equal(call.opts.method, "PATCH");
  const body = JSON.parse(call.opts.body);
  assert.equal(body.status, "resolved");
  assert.equal(body.resolution, "Fixed the thing.");
  assert.equal(body.resolvedBy, "assistant");
});

test("updateIssueOnServer skips the base instead of creating a duplicate on 404", async () => {
  // After the fix for "Consumer resolves duplicate issue copies but doesn't
  // close the original", a 404 on PATCH means the issue doesn't exist on this
  // server. We must NOT create a copy — that would produce a duplicate with a
  // different ID while leaving the original unresolved. Instead we skip this
  // base and let the other configured bases (or the original queue server)
  // handle the resolution.
  const mock = mockFetchSequence([
    fakeResponse(404, {}),
  ]);
  try {
    await updateIssueOnServer(
      { id: "external-9", summary: "Queued externally", category: "test" },
      "resolved",
      "Fixed remotely.",
    );
  } finally {
    mock.restore();
  }

  assert.equal(mock.calls.length, 1, "expected only one PATCH attempt, no duplicate-creating POST");
  assert.equal(
    mock.calls[0].url,
    "http://api.invalid/api/assistant/issues/external-9",
  );
  assert.equal(mock.calls[0].opts.method, "PATCH");
});

test("consumeOne calls update_issue (PATCH) once the CLI process completes", async () => {
  const issue = {
    id: "issue-complete",
    summary: "Consumer should report completion",
    category: "test",
    createdAt: new Date().toISOString(),
  };

  const mock = mockFetchSequence([
    fakeResponse(200, [issue]), // GET from API returns array of open issues
    fakeResponse(200, { ok: true }), // PATCH update on completion
  ]);
  try {
    const hadWork = await consumeOne();
    assert.equal(hadWork, true);
  } finally {
    mock.restore();
  }

  assert.equal(mock.calls.length, 2, "expected an API GET and an update_issue PATCH");
  assert.equal(mock.calls[0].opts.method, "GET");
  assert.equal(
    mock.calls[0].url,
    "http://api.invalid/api/assistant/issues?status=open",
  );
  assert.equal(mock.calls[1].opts.method, "PATCH");
  assert.equal(
    mock.calls[1].url,
    "http://api.invalid/api/assistant/issues/issue-complete",
  );
  const body = JSON.parse(mock.calls[1].opts.body);
  assert.equal(body.status, "resolved");
});

test("updateIssueOnServer logs a failure (not a throw) on non-404 error status", async () => {
  const mock = mockFetchSequence([fakeResponse(500, {})]);
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await assert.doesNotReject(() =>
      updateIssueOnServer(
        { id: "issue-500", summary: "Server hiccup" },
        "resolved",
        "Attempted fix.",
      ),
    );
  } finally {
    console.log = originalLog;
    mock.restore();
  }

  assert.equal(mock.calls.length, 1);
  assert.ok(
    logs.some((l) => l.includes("Failed to update issue issue-500 on http://api.invalid: HTTP 500")),
    "expected a logged failure referencing the issue id",
  );
});

test("updateIssueOnServer pushes the update to both the local and EC2 API bases when EC2_API is set", async () => {
  // Force a fresh module instance with EC2_API set, since ISSUE_API_BASES is
  // computed once at import time. A cache-busting query param gives us an
  // isolated copy without affecting the module already used by other tests.
  process.env.EC2_API = "http://ec2.invalid";
  let dualUpdateModule;
  try {
    dualUpdateModule = await import(`./issue-consumer.mjs?dual-update=${Date.now()}`);
  } finally {
    delete process.env.EC2_API;
  }
  dualUpdateModule.setAuthHeaderForTest("******");

  const mock = mockFetchSequence([
    fakeResponse(200, { ok: true }), // PATCH on local base
    fakeResponse(200, { ok: true }), // PATCH on EC2 base
  ]);
  try {
    await dualUpdateModule.updateIssueOnServer(
      { id: "issue-dual", summary: "Dual update" },
      "resolved",
      "Fixed on both hosts.",
    );
  } finally {
    mock.restore();
  }

  assert.equal(mock.calls.length, 2, "expected one PATCH per API base");
  assert.equal(
    mock.calls[0].url,
    "http://api.invalid/api/assistant/issues/issue-dual",
  );
  assert.equal(
    mock.calls[1].url,
    "http://ec2.invalid/api/assistant/issues/issue-dual",
  );
});

test("updateIssueOnServer catches network errors and still logs the issue id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await assert.doesNotReject(() =>
      updateIssueOnServer(
        { id: "issue-net-fail", summary: "Network blip" },
        "resolved",
        "Attempted fix.",
      ),
    );
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }

  assert.ok(
    logs.some((l) =>
      l.includes("Error updating issue-net-fail on http://api.invalid: network down"),
    ),
    "expected the catch block to log the issue id and API base on network failure",
  );
});
