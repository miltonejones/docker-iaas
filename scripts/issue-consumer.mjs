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

import { spawn } from "node:child_process";
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

let running = true;

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

  // Skip if there are already uncommitted changes — likely a duplicate
  // while a previous fix is still in-flight.
  const { execSync: _exec } = await import("node:child_process");
  try {
    const pending = _exec("git diff --stat", { cwd: CODEBASE_PATH, encoding: "utf8", timeout: 5_000 }).trim();
    if (pending) {
      log(`Skipping ${issue.id} — uncommitted changes already present (likely duplicate):\n${pending}`);
      notify(`⏭️ Skipped duplicate: ${issue.summary}`, "Uncommitted changes already present");
      return true; // consumed from queue but skipped
    }
  } catch { /* proceed if git diff fails */ }

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

    child.once("close", (code) => {
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
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

loop();
