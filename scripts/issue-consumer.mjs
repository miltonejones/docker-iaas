#!/usr/bin/env node
// Polls the Dockyard API directly for open issues and feeds each one to a
// local DeepSeek CLI with access to this codebase.  Logs every session to
// scripts/issue-logs/.
//
//   node scripts/issue-consumer.mjs
//
// Environment variables:
//   DOCKYARD_API       – base URL of the Dockyard API (default: http://127.0.0.1:4300)
//   DEEPSEEK_CMD       – Claude Code CLI command  (default: copilot)
//   CODEBASE_PATH      – path DeepSeek should work against (default: ../.. relative to this script = repo root)
//   POLL_INTERVAL_MS   – ms between polls when idle (default: 5000)
//   POLL_INTERVAL_ACTIVE_MS – ms between polls after processing (default: 1000)

import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEEPSEEK_CMD = process.env.DEEPSEEK_CMD || "copilot";
const CODEBASE_PATH = path.resolve(
  process.env.CODEBASE_PATH || path.join(__dirname, ".."),
);
const LOG_DIR = path.join(__dirname, "issue-logs");
const POLL_MS = Number(process.env.POLL_INTERVAL_MS) || 5_000;
const ACTIVE_MS = Number(process.env.POLL_INTERVAL_ACTIVE_MS) || 1_000;
const DOCKYARD_API = process.env.DOCKYARD_API || "http://127.0.0.1:4300";
const ON_EC2 = process.env.ON_EC2 === "true" || process.env.CONSUMER_ON_EC2 === "true";

// ── Auth token for PATCH-ing issues back to the local server ──────────
const JWT_SECRET = process.env.JWT_SECRET || "dockyard-dev-secret-change-in-production";
let authHeader = process.env.DOCKYARD_API_TOKEN
  ? `Bearer ${process.env.DOCKYARD_API_TOKEN}`
  : "";

// Issue updates are pushed to every API in this list so both the local
// server and the EC2 instance stay in sync.  EC2 uses the same port on
// the same host targeted by the deploy rsync step.
const ISSUE_API_BASES = [
  DOCKYARD_API,
];
if (process.env.EC2_API || process.env.EC2_HOST) {
  const ec2Host = process.env.EC2_API || `http://${process.env.EC2_HOST || "54.162.111.41"}:4300`;
  ISSUE_API_BASES.push(ec2Host);
}

/** Try to resolve a userId from the project DB and sign a JWT. Falls back
 *  to the DOCKYARD_API_TOKEN env var if the DB is unreachable. */
function initAuthHeader() {
  if (authHeader) {
    log("Using DOCKYARD_API_TOKEN for issue updates.");
    return;
  }
  try {
    const dbFile = path.join(CODEBASE_PATH, "data", "iaas.db");
    if (!fs.existsSync(dbFile)) {
      log("No iaas.db found — set DOCKYARD_API_TOKEN to enable issue updates.");
      return;
    }
    const q = `const D=require('better-sqlite3');const d=new D('${dbFile}',{readonly:true});const r=d.prepare('SELECT id,email FROM users LIMIT 1').get();d.close();console.log(r?JSON.stringify(r):'')`;
    const out = execSync(`"${process.execPath}" -e "${q.replace(/"/g, '\\"')}"`, {
      cwd: CODEBASE_PATH,
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    if (!out) {
      log("No user in iaas.db — set DOCKYARD_API_TOKEN to enable issue updates.");
      return;
    }
    const row = JSON.parse(out);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ userId: row.id, email: row.email, iat: now, exp: now + 86400 })).toString("base64url");
    const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
    authHeader = `Bearer ${header}.${payload}.${sig}`;
    log(`Authenticated as ${row.email} (${row.id}) for issue updates.`);
  } catch (err) {
    log(`Failed to init auth from DB (set DOCKYARD_API_TOKEN to bypass): ${err.message}`);
  }
}

let running = true;
let lastHeartbeat = 0;

// Track recently seen issue summaries to detect true duplicates.
// Key: normalized summary, Value: timestamp when first seen.
const recentSummaries = new Map();
const DEDUPE_WINDOW_MS = 10 * 60_000; // 10 minutes

function isDuplicate(summary) {
  const key = summary.trim().toLowerCase();
  const now = Date.now();
  // Purge expired entries
  for (const [k, ts] of recentSummaries) {
    if (now - ts > DEDUPE_WINDOW_MS) recentSummaries.delete(k);
  }
  if (recentSummaries.has(key)) return true;
  recentSummaries.set(key, now);
  return false;
}

fs.mkdirSync(LOG_DIR, { recursive: true });

const NOTIFY_LOG = path.join(LOG_DIR, "notifications.jsonl");

/** Append a structured notification event so a local watcher can relay it.
 *  Also POSTs to the Dockyard API so notifications reach the shared log even
 *  when the consumer runs in a container without a host volume mount — the
 *  Dockyard server's own volume mount writes them to the host filesystem. */
function notifyLog(summary, body = "", level = "info") {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    summary,
    body: body || "",
  }) + "\n";
  try { fs.appendFileSync(NOTIFY_LOG, entry, "utf8"); } catch {}

  // Fire-and-forget POST to the Dockyard API so that containerized consumers
  // without a host volume mount still deliver notifications to the shared log.
  const payload = JSON.parse(entry);
  fetch(`${DOCKYARD_API}/api/notifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {}); // best-effort — ignore unreachable API
}

function notify(summary, body = "") {
  notifyLog(summary, body);
  try {
    const n = spawn("notify-send", [
      "--app-name=Dockyard",
      "--icon=dialog-information",
      summary,
      body,
    ], { stdio: "ignore", detached: true });
    n.on("error", () => {}); // suppress ENOENT on headless servers
    n.unref();
  } catch {
    // notify-send not available (e.g. headless server) — log handles it
  }
}

/** Extract a concise resolution summary from assistant stdout. */
function extractResolution(stdout) {
  // Try the "## Diagnosis" section first — it explains what was wrong.
  const diag = stdout.match(/## Diagnosis\s*\n+(.+?)(?:\n##|\n\*\*|\n{3,}|$)/s);
  if (diag) return diag[1].trim().slice(0, 500);

  // Fall back to the last non-empty paragraph.
  const paras = stdout.split(/\n\n+/).filter((p) => p.trim());
  if (paras.length) return paras[paras.length - 1].trim().slice(0, 500);

  return "Fixed by automated assistant.";
}

/** PATCH /api/assistant/issues/:id against a single API base.  If the issue
 *  isn't found (404), logs and skips — creating a copy would produce a
 *  duplicate with a different ID while leaving the original unresolved. */
async function updateIssueOneBase(baseUrl, issue, status, resolution) {
  const issueId = issue?.id;
  const patchUrl = `${baseUrl}/api/assistant/issues/${encodeURIComponent(issueId)}`;
  let res = await fetch(patchUrl, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify({ status, resolution, resolvedBy: "assistant" }),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 404) {
    // The issue doesn't exist on this server — nothing to update here.
    // Creating a copy would produce a duplicate with a different ID while
    // leaving the original unresolved, so just skip this base.
    log(`Issue ${issueId} not found on ${baseUrl} — skipping (nothing to resolve).`);
    return false;
  }

  if (res.ok) {
    log(`Issue ${issueId} updated on ${baseUrl}: ${status}`);
    return true;
  }
  log(`Failed to update issue ${issueId} on ${baseUrl}: HTTP ${res.status}`);
  return false;
}

/** Push the issue status update to every configured API base (local + EC2). */
async function updateIssueOnServer(issue, status, resolution) {
  if (!authHeader) return;
  for (const base of ISSUE_API_BASES) {
    try { await updateIssueOneBase(base, issue, status, resolution); }
    catch (err) { log(`Error updating ${issue.id} on ${base}: ${err.message}`); }
  }
}

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function formatPrompt(issue) {
  const { id, summary, category, details, createdAt } = issue;
  const detailBlock =
    details && typeof details === "object"
      ? Object.entries(details)
          .map(([k, v]) =>
            `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
          )
          .join("\n")
      : "  (none)";

  return [
    `The codebase is at ${CODEBASE_PATH}.`,
    `Examine the relevant source files, diagnose the root cause, and implement a fix.`,
    `After your analysis, explain what you found and what you changed (if anything).`,
    ``,
    `## Issue`,
    ``,
    `**ID:** ${id}`,
    `**Category:** ${category || "general"}`,
    `**Reported:** ${createdAt}`,
    `**Summary:** ${summary}`,
    ``,
    `### Details`,
    ``,
    detailBlock,
    ``,
    `## Instructions`,
    ``,
    `1. Read any files referenced in the issue details.`,
    `2. Reproduce the reasoning — why did this happen?`,
    `3. If there is a clear fix, implement it by editing the files.`,
    `4. Summarize your changes at the end.`,
  ].join("\n");
}

function logFilename(issueId) {
  const safe = issueId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const date = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(LOG_DIR, `${safe}-${date}.md`);
}

async function pushToGitHub(issue) {
  const { execSync } = await import("node:child_process");

  // Check if copilot changed any files.
  let diff;
  try {
    diff = execSync("git diff --stat", { cwd: CODEBASE_PATH, encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    // Fallback: find-based detection (backward compat, no git repo).
    try {
      diff = execSync(
        `find . -type f -newer /tmp/dockyard-deploy-marker \\\n          \\( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.html' -o -name '*.json' -o -name '*.sql' -o -name '*.md' -o -name 'Dockerfile' -o -name 'Caddyfile' -o -name '*.svg' \\) \\\n          ! -path './node_modules/*' ! -path './data/*' ! -path './scripts/issue-logs/*' \\\n          -printf '%p\\n' | sort`,
        { cwd: CODEBASE_PATH, encoding: "utf8", timeout: 10_000 },
      ).trim();
    } catch {
      log("Could not detect changes — skipping push");
      return;
    }
  }

  if (!diff) {
    log("No file changes — skipping push");
    return;
  }
  log(`Changes detected:\n${diff}`);

  // Commit locally first so copilot's changes are staged, then pull --rebase
  // to integrate any new commits from the remote.
  try {
    execSync(`git add -A && git commit -m "fix: ${issue.summary}"`, {
      cwd: CODEBASE_PATH,
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch (err) {
    if (err.message.includes("nothing to commit")) {
      log("No file changes — skipping push");
      return;
    }
    log(`git commit failed: ${err.message}`);
    return;
  }

  try {
    execSync("git pull --rebase origin main", { cwd: CODEBASE_PATH, timeout: 30_000 });
  } catch (err) {
    log(`Merge conflict: ${err.message}`);
    notify("⚠️ Merge conflict", `Fix for "${issue.summary}" needs manual review`);
    try { execSync("git rebase --abort", { cwd: CODEBASE_PATH, timeout: 5_000 }); } catch {}
    return;
  }

  try {
    execSync("git push origin main", { cwd: CODEBASE_PATH, timeout: 30_000 });
    log("Pushed to GitHub — CI will deploy.");
    notify("📤 Pushed fix to GitHub", issue.summary);
  } catch (err) {
    log(`git push failed: ${err.message}`);
    notify("⚠️ Push failed", `Fix for "${issue.summary}" couldn't push — will retry`);
  }
}

async function consumeOne() {
  // Auth is required to poll the API directly.  If we don't have a token yet
  // (e.g. DB unavailable and DOCKYARD_API_TOKEN not set), log a heartbeat and
  // keep waiting — initAuthHeader may succeed on a later retry.
  if (!authHeader) {
    if (Date.now() - lastHeartbeat > 60_000) {
      log("No auth token — cannot poll for issues. Set DOCKYARD_API_TOKEN or ensure the DB is accessible.");
      lastHeartbeat = Date.now();
    }
    return false;
  }

  let res;
  try {
    const pollUrl = `${DOCKYARD_API}/api/assistant/issues?status=open`;
    res = await fetch(pollUrl, {
      method: "GET",
      headers: {
        Authorization: authHeader,
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log(`Failed to reach API: ${err.message}`);
    return false;
  }

  if (!res.ok) {
    log(`API returned HTTP ${res.status}`);
    return false;
  }

  let issues;
  try {
    issues = await res.json();
  } catch {
    log("API returned unparseable response");
    return false;
  }

  if (!Array.isArray(issues) || issues.length === 0) {
    // Log a heartbeat once a minute so we know the daemon is alive.
    if (Date.now() - lastHeartbeat > 60_000) {
      log("Polling — no open issues");
      lastHeartbeat = Date.now();
    }
    return false;
  }

  // Pick the first open issue we haven't seen recently.
  const issue = issues.find((i) => !isDuplicate(i.summary));
  if (!issue) {
    if (Date.now() - lastHeartbeat > 60_000) {
      log(`Polling — ${issues.length} open issue(s), all recently processed`);
      lastHeartbeat = Date.now();
    }
    return false;
  }

  log(`Processing issue ${issue.id}: ${issue.summary}`);
  notify(`🐛 ${issue.summary}`, `Category: ${issue.category || "general"}\nID: ${issue.id}`);

  const prompt = formatPrompt(issue);
  const file = logFilename(issue.id);

  let stdout = "";
  let stderr = "";

  await new Promise((resolve) => {
    // copilot/claude -p runs non-interactively; no TTY needed.
    const child = spawn(DEEPSEEK_CMD, [
      "-p", prompt,
      "--model", process.env.DEEPSEEK_MODEL || "deepseek-v4-pro",
      "--dangerously-skip-permissions",
    ], {
      cwd: CODEBASE_PATH,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.once("close", async (code) => {
      // Write session log
      const report = [
        `# Issue ${issue.id}`,
        ``,
        `**Summary:** ${issue.summary}`,
        `**Category:** ${issue.category || "general"}`,
        `**Reported:** ${issue.createdAt}`,
        `**Exit code:** ${code}`,
        ``,
        `## Prompt`,
        ``,
        "```",
        prompt,
        "```",
        ``,
        `## Response`,
        ``,
        stdout || "(no output)",
        ``,
      ];
      if (stderr) {
        report.push(`## stderr`, ``, "```", stderr, "```", ``);
      }

      try {
        fs.writeFileSync(file, report.join("\n"), "utf8");
        log(`Session logged: ${file}`);
      } catch (err) {
        log(`Failed to write log: ${err.message}`);
      }

      if (code === 0) {
        log(`Issue ${issue.id} processed.`);
        notify(`✅ Fixed: ${issue.summary}`);
        await updateIssueOnServer(
          issue,
          "resolved",
          extractResolution(stdout),
        );
        pushToGitHub(issue); // fire-and-forget — CI handles the deploy
      } else {
        log(`Copilot exited with code ${code} for issue ${issue.id}`);
        notify(`❌ Failed: ${issue.summary}`, `Exit code: ${code}`);
        if (stderr && !stdout) log(`stderr: ${stderr.slice(0, 500)}`);
      }
      resolve();
    });

    child.once("error", (err) => {
      log(`Failed to start DeepSeek: ${err.message}`);
      // Still write the prompt to the log so the issue isn't lost.
      try {
        fs.writeFileSync(
          file,
          [
            `# Issue ${issue.id}`,
            ``,
            `**Summary:** ${issue.summary}`,
            `**Category:** ${issue.category || "general"}`,
            `**Reported:** ${issue.createdAt}`,
            `**Error:** ${err.message}`,
            ``,
            `## Prompt`,
            ``,
            "```",
            prompt,
            "```",
            ``,
          ].join("\n"),
          "utf8",
        );
      } catch { /* best-effort */ }
      resolve();
    });
  });

  return true;
}

async function loop() {
  log(`Consumer started. API: ${DOCKYARD_API}  CLI: ${DEEPSEEK_CMD}  Codebase: ${CODEBASE_PATH}  EC2: ${ON_EC2}`);
  notifyLog("🟢 Consumer online", `API: ${DOCKYARD_API}\nCodebase: ${CODEBASE_PATH}\nEC2: ${ON_EC2}`);
  initAuthHeader();
  while (running) {
    try {
      const hadWork = await consumeOne();
      await sleep(hadWork ? ACTIVE_MS : POLL_MS);
    } catch (err) {
      log(`Unexpected error: ${err.message}`);
      await sleep(POLL_MS);
    }
  }
  log("Consumer stopped.");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function shutdown() {
  running = false;
}

// Only wire up signal handlers and start the poll loop when this file is
// executed directly (`node scripts/issue-consumer.mjs`). When imported by
// a test suite we want the exported functions without any side effects.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  loop();
}

/** Test-only helper to inject an auth header without touching the DB/JWT flow. */
function setAuthHeaderForTest(value) {
  authHeader = value;
}

export {
  updateIssueOnServer,
  consumeOne,
  extractResolution,
  formatPrompt,
  pushToGitHub,
  setAuthHeaderForTest,
};
