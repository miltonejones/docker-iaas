// Tests for scripts/issue-consumer.mjs
//
// Run with: node --test scripts/issue-consumer.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

// Point the consumer at fake endpoints and a no-op "CLI" (`true` exits 0
// immediately) *before* importing the module, since these are read once
// at import time.
process.env.ISSUE_QUEUE_URL = "http://queue.invalid/consume";
process.env.DOCKYARD_API = "http://api.invalid";
process.env.DEEPSEEK_CMD = "true";

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

test("updateIssueOnServer creates the issue locally then retries PATCH on 404", async () => {
  const mock = mockFetchSequence([
    fakeResponse(404, {}),
    fakeResponse(201, { id: "local-42" }),
    fakeResponse(200, { ok: true }),
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

  assert.equal(mock.calls.length, 3);
  assert.equal(
    mock.calls[2].url,
    "http://api.invalid/api/assistant/issues/local-42",
  );
});

test("consumeOne calls update_issue (PATCH) once the CLI process completes", async () => {
  const issue = {
    id: "issue-complete",
    summary: "Consumer should report completion",
    category: "test",
    createdAt: new Date().toISOString(),
  };

  const mock = mockFetchSequence([
    fakeResponse(200, { issue }), // POST to the queue returns work
    fakeResponse(200, { ok: true }), // PATCH update on completion
  ]);
  try {
    const hadWork = await consumeOne();
    assert.equal(hadWork, true);
  } finally {
    mock.restore();
  }

  assert.equal(mock.calls.length, 2, "expected a queue fetch and an update_issue PATCH");
  assert.equal(mock.calls[0].opts.method, "POST");
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
    logs.some((l) => l.includes("Failed to update issue issue-500: HTTP 500")),
    "expected a logged failure referencing the issue id",
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
      l.includes("Failed to update issue issue-net-fail: network down"),
    ),
    "expected the catch block to reference issueId even though it's declared outside the try",
  );
});
