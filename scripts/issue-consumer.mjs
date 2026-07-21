#!/usr/bin/env node
// Polls the Dockyard issue queue and feeds each issue to a local DeepSeek CLI
// with access to this codebase.  Logs every session to scripts/issue-logs/.
//
//   node scripts/issue-consumer.mjs
//
// Environment variables:
//   ISSUE_QUEUE_URL    – consume endpoint (default: https://dockyard-ai.com/gw/issues/consume)
//   DEEPSEEK_CMD       – DeepSeek CLI command  (default: deepseek)
//   CODEBASE_PATH      – path DeepSeek should work against (default: ../.. relative to this script = repo root)
//   POLL_INTERVAL_MS   – ms between polls when idle (default: 5000)
//   POLL_INTERVAL_ACTIVE_MS – ms between polls after processing (default: 1000)

import { spawn, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const QUEUE_URL =
  process.env.ISSUE_QUEUE_URL || "https://dockyard-ai.com/gw/issues/consume";
const DEEPSEEK_CMD = process.env.DEEPSEEK_CMD || "copilot";
const CODEBASE_PATH = path.resolve(
  process.env.CODEBASE_PATH || path.join(__dirname, ".."),
);
const LOG_DIR = path.join(__dirname, "issue-logs");
const POLL_MS = Number(process.env.POLL_INTERVAL_MS) || 5_000;
const ACTIVE_MS = Number(process.env.POLL_INTERVAL_ACTIVE_MS) || 1_000;
const DOCKYARD_API = process.env.DOCKYARD_API || "http://127.0.0.1:4300";

// ── Auth token for PATCH-ing issues back to the local server ──────────
const JWT_SECRET = process.env.JWT_SECRET || "dockyard-dev-secret-change-in-production";
let authHeader = process.env.DOCKYARD_API_TOKEN
  ? `Bearer ${process.env.DOCKYARD_API_TOKEN}`
  : "";

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

function notify(summary, body = "") {
  const n = spawn("notify-send", [
    "--app-name=Dockyard",
    "--icon=dialog-information",
    summary,
    body,
  ], { stdio: "ignore", detached: true });
  n.unref();
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

/** Call PATCH /api/assistant/issues/:id to record status and resolution.
 *  If the issue doesn't exist locally (404), creates it first. */
async function updateIssueOnServer(issue, status, resolution) {
  // Declared outside the try block so it remains accessible in the catch
  // handler below — `const` inside `try {}` is scoped to that block only.
  const issueId = issue?.id;
  try {
    if (!authHeader) return; // no user — skip
    const patchUrl = `${DOCKYARD_API}/api/assistant/issues/${encodeURIComponent(issueId)}`;
    let res = await fetch(patchUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({ status, resolution, resolvedBy: "assistant" }),
      signal: AbortSignal.timeout(10_000),
    });

    // If the issue was reported directly to the external queue, it won't
    // exist in the local DB yet — create it first, then patch.
    if (res.status === 404) {
      log(`Issue ${issueId} not found locally — creating it first.`);
      const createRes = await fetch(`${DOCKYARD_API}/api/assistant/issues`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify({
          summary: issue.summary,
          category: issue.category,
          details: issue.details,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!createRes.ok) {
        log(`Failed to create issue ${issueId} locally: HTTP ${createRes.status}`);
        return;
      }
      // The server always mints its own id on create — it does not preserve
      // the id assigned by the external queue — so the retry must target
      // the newly-created local id, not the original patchUrl.
      const created = await createRes.json();
      const localId = created?.id;
      if (!localId) {
        log(`Created issue for ${issueId} but response had no id — cannot patch.`);
        return;
      }
      const localPatchUrl = `${DOCKYARD_API}/api/assistant/issues/${encodeURIComponent(localId)}`;
      res = await fetch(localPatchUrl, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify({ status, resolution, resolvedBy: "assistant" }),
        signal: AbortSignal.timeout(10_000),
      });
    }

    if (res.ok) {
      log(`Issue ${issueId} updated: ${status}`);
    } else {
      log(`Failed to update issue ${issueId}: HTTP ${res.status}`);
    }
  } catch (err) {
    log(`Failed to update issue ${issueId}: ${err.message}`);
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

async function deploy(issue) {
  // Check if copilot actually changed any files
  const { execSync } = await import("node:child_process");
  let diff;
  try {
    diff = execSync("git diff --stat", { cwd: CODEBASE_PATH, encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    log("git diff failed — skipping deploy");
    return;
  }
  if (!diff) {
    log("No file changes — skipping deploy");
    return;
  }
  log(`Changes detected:\n${diff}`);
  notify("🚀 Deploying...", "Local + EC2 deploy started");

  // --- Local deploy ---
  log("Starting local deploy...");
  try {
    const localOut = execSync(
      "docker compose up --build -d --remove-orphans && docker image prune -f",
      { cwd: CODEBASE_PATH, encoding: "utf8", timeout: 300_000 },
    );
    log(`Local deploy OK:\n${localOut.trim()}`);
  } catch (err) {
    log(`Local deploy FAILED: ${err.message}`);
    notify("❌ Local deploy failed", err.message);
    return; // don't proceed to EC2 if local fails
  }

  // --- EC2 deploy ---
  log("Starting EC2 deploy...");
  const keyFile = "/home/miltonejones/.ssh/dockyard-key.pem";
  const remote = "ec2-user@54.162.111.41";
  const remotePath = "/home/ec2-user/docker-iaas";
  const sshOpts = `ssh -i ${keyFile} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15`;

  try {
    // rsync source (excluding sensitive/persistent paths)
    execSync(
      `rsync -az --delete ` +
        `--exclude '.git/' --exclude 'node_modules/' --exclude 'data/' ` +
        `--exclude '.env' --exclude '.claude/' ` +
        `-e '${sshOpts}' ` +
        `./ ${remote}:${remotePath}/`,
      { cwd: CODEBASE_PATH, encoding: "utf8", timeout: 120_000 },
    );
    log("rsync OK");

    // Remote docker compose
    const remoteOut = execSync(
      `${sshOpts} ${remote} ` +
        `'cd ${remotePath} && docker compose up --build -d --remove-orphans && docker image prune -f'`,
      { encoding: "utf8", timeout: 300_000 },
    );
    log(`EC2 deploy OK:\n${remoteOut.trim()}`);
    notify("✅ Deployed to EC2", "Local + EC2 deploy complete");

    // Auto-commit so the working tree is clean for the next issue.
    try {
      execSync(`git add -A && git commit -m "fix: ${issue.summary}"`, {
        cwd: CODEBASE_PATH,
        encoding: "utf8",
        timeout: 10_000,
      });
      log("Changes committed.");
    } catch (err) {
      log(`git commit failed: ${err.message}`);
    }
  } catch (err) {
    log(`EC2 deploy FAILED: ${err.message}`);
    notify("❌ EC2 deploy failed", err.message);
  }
}

async function consumeOne() {
  let res;
  try {
    res = await fetch(QUEUE_URL, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log(`Failed to reach queue: ${err.message}`);
    return false;
  }

  if (!res.ok) {
    log(`Queue returned HTTP ${res.status}`);
    return false;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    log("Queue returned unparseable response");
    return false;
  }

  if (!body.issue) {
    return false; // empty
  }

  const issue = body.issue;

  // Skip if we've seen this exact summary recently — true duplicate.
  if (isDuplicate(issue.summary)) {
    log(`Skipping ${issue.id} — duplicate summary: "${issue.summary}"`);
    notify(`⏭️ Skipped duplicate: ${issue.summary}`, `Same summary seen within ${DEDUPE_WINDOW_MS / 60_000} min`);
    return true;
  }

  log(`Processing issue ${issue.id}: ${issue.summary}`);
  notify(`🐛 ${issue.summary}`, `Category: ${issue.category || "general"}\nID: ${issue.id}`);

  const prompt = formatPrompt(issue);
  const file = logFilename(issue.id);

  let stdout = "";
  let stderr = "";

  await new Promise((resolve) => {
    // copilot -p runs non-interactively; no TTY needed.
    const child = spawn(DEEPSEEK_CMD, [
      "-p", prompt,
      "--yolo",
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
        deploy(issue); // fire-and-forget — don't block next poll
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
  log(`Consumer started. Queue: ${QUEUE_URL}  CLI: ${DEEPSEEK_CMD}  Codebase: ${CODEBASE_PATH}`);
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
  setAuthHeaderForTest,
};
