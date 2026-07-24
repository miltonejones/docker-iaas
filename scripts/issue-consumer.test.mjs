// Tests for scripts/issue-consumer.mjs
//
// Run with: node --test scripts/issue-consumer.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// Point the consumer at a throwaway sandbox repo. consumeOne fires
// pushToGitHub (fire-and-forget), which runs real git checkout/add/commit/push
// against CODEBASE_PATH — without this it would mutate the actual repo (and
// revert protected files) whenever these tests run, including in CI.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-sandbox-"));
try { execSync("git init -q", { cwd: SANDBOX }); } catch { /* git may be unavailable */ }
process.env.CODEBASE_PATH = SANDBOX;
process.on("exit", () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {} });

const {
  updateIssueOnServer,
  consumeOne,
  extractResolution,
  parseStructuredResult,
  revertAndStageProtected,
  PROTECTED,
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
  // The real CLI exits 0 but doesn't emit the structured JSON result,
  // so the consumer now marks the issue "needs_review" (no changes made)
  // instead of "resolved".
  assert.ok(body.status === "needs_review" || body.status === "resolved");
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

// ---------------------------------------------------------------------------
// Protected-file enforcement (revertAndStageProtected)
//
// The headline safety fix: a model edit to a protected file must never land in
// a commit. These tests exercise the real production helper against a throwaway
// git repo, so the safety property is verified end-to-end (revert + staging).
// ---------------------------------------------------------------------------

/** Create an isolated temp git repo with the given files committed. Returns the
 *  repo path; the caller is responsible for cleanup via fs.rmSync. */
function makeTempRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-protect-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email test@dockyard.test", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  execSync("git add -A && git commit -q -m init", { cwd: dir });
  return dir;
}

test("revertAndStageProtected keeps a protected-file edit out of the commit", () => {
  const dir = makeTempRepo({
    "docker-compose.yml": "orig-compose\n",
    "app.js": "orig-app\n",
  });
  try {
    // Simulate the model editing BOTH a protected file and a normal file.
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), "MALICIOUS-EDIT\n");
    fs.writeFileSync(path.join(dir, "app.js"), "legit-fix\n");

    revertAndStageProtected(dir, ["docker-compose.yml"]);

    const staged = execSync("git diff --cached --name-only", { cwd: dir, encoding: "utf8" }).trim();
    assert.equal(staged, "app.js", "only the normal file should be staged");

    // The protected file's working-tree edit must be reverted.
    assert.equal(fs.readFileSync(path.join(dir, "docker-compose.yml"), "utf8"), "orig-compose\n");

    // And after committing, the protected file in the commit must be unchanged.
    execSync("git commit -q -m fix", { cwd: dir });
    assert.equal(
      execSync("git show HEAD:docker-compose.yml", { cwd: dir, encoding: "utf8" }),
      "orig-compose\n",
      "the malicious edit must never land in a commit",
    );
    assert.equal(execSync("git show HEAD:app.js", { cwd: dir, encoding: "utf8" }), "legit-fix\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("revertAndStageProtected excludes even a newly-created protected file", () => {
  const dir = makeTempRepo({ "app.js": "orig-app\n" });
  try {
    // Model creates a brand-new file at a protected path (untracked) plus a
    // legit change. `git checkout --` can't revert an untracked file, so this
    // proves the :(exclude) pathspec is the independent safety net.
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), "SNEAKY-NEW\n");
    fs.writeFileSync(path.join(dir, "app.js"), "legit-fix\n");

    revertAndStageProtected(dir, ["docker-compose.yml"]);

    const staged = execSync("git diff --cached --name-only", { cwd: dir, encoding: "utf8" }).trim();
    assert.equal(staged, "app.js", "the untracked protected file must not be staged");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("revertAndStageProtected stages normal changes untouched when no protected file is edited", () => {
  const dir = makeTempRepo({ "app.js": "orig-app\n", "docker-compose.yml": "orig-compose\n" });
  try {
    fs.writeFileSync(path.join(dir, "app.js"), "legit-fix\n");

    revertAndStageProtected(dir, ["docker-compose.yml"]);

    const staged = execSync("git diff --cached --name-only", { cwd: dir, encoding: "utf8" }).trim();
    assert.equal(staged, "app.js");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the shared PROTECTED list is loaded from protected-files.json", () => {
  // Guards against the enforcement silently no-opping if the file goes missing.
  assert.ok(Array.isArray(PROTECTED) && PROTECTED.length > 0, "PROTECTED must be non-empty");
  for (const expected of ["scripts/issue-consumer.mjs", "docker-compose.yml", ".gitignore"]) {
    assert.ok(PROTECTED.includes(expected), `PROTECTED should include ${expected}`);
  }
});

// ---------------------------------------------------------------------------
// parseStructuredResult — unit tests (no spawning, no network)
// ---------------------------------------------------------------------------

test("parseStructuredResult extracts a valid JSON line from stdout", () => {
  const stdout = [
    "Some analysis text",
    "",
    "## Diagnosis",
    "The button was missing a border.",
    "",
    '{"changedFiles":["styles.css"],"rootCause":"missing CSS rule","diagnosis":"border was omitted","confidence":"high"}',
  ].join("\n");

  const result = parseStructuredResult(stdout);
  assert.ok(result);
  assert.deepEqual(result.changedFiles, ["styles.css"]);
  assert.equal(result.rootCause, "missing CSS rule");
  assert.equal(result.diagnosis, "border was omitted");
  assert.equal(result.confidence, "high");
});

test("parseStructuredResult finds JSON even if not the last line", () => {
  const stdout = '{"changedFiles":["a.ts","b.ts"],"rootCause":"x","diagnosis":"y","confidence":"medium"}\nsome trailing text';
  const result = parseStructuredResult(stdout);
  assert.ok(result);
  assert.deepEqual(result.changedFiles, ["a.ts", "b.ts"]);
  assert.equal(result.confidence, "medium");
});

test("parseStructuredResult returns null for empty stdout", () => {
  assert.equal(parseStructuredResult(""), null);
});

test("parseStructuredResult returns null when no JSON with changedFiles", () => {
  assert.equal(parseStructuredResult("Just some plain text\nno JSON here\n"), null);
});

test("parseStructuredResult returns null for JSON missing changedFiles", () => {
  assert.equal(parseStructuredResult('{"notChangedFiles":[],"rootCause":"x"}'), null);
});

test("parseStructuredResult filters non-string entries from changedFiles", () => {
  const result = parseStructuredResult('{"changedFiles":["a.ts", 123, null, "b.ts"],"rootCause":"x"}');
  assert.ok(result);
  assert.deepEqual(result.changedFiles, ["a.ts", "b.ts"]);
});

test("parseStructuredResult defaults confidence to medium for invalid", () => {
  assert.equal(
    parseStructuredResult('{"changedFiles":["x.ts"],"rootCause":"r","confidence":"unknown"}').confidence,
    "medium"
  );
});

// ---------------------------------------------------------------------------
// extractResolution — structured + fallback paths
// ---------------------------------------------------------------------------

test("extractResolution uses structured diagnosis when available", () => {
  const stdout = '{"changedFiles":["a.ts"],"rootCause":"r","diagnosis":"button missing border","confidence":"high"}';
  assert.equal(extractResolution(stdout), "button missing border");
});

test("extractResolution falls back to ## Diagnosis regex without structured result", () => {
  const stdout = "Some text\n\n## Diagnosis\nThe widget was broken.\n\n## Next Section\nMore text";
  assert.equal(extractResolution(stdout), "The widget was broken.");
});

test("extractResolution falls back to last paragraph when no diagnosis", () => {
  assert.equal(extractResolution("Line one\n\nLast paragraph here."), "Last paragraph here.");
});

test("extractResolution truncates at 500 characters", () => {
  const long = "x".repeat(600);
  const stdout = '{"changedFiles":["a.ts"],"diagnosis":"' + long + '"}';
  const result = extractResolution(stdout);
  assert.equal(result.length, 500);
});
