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
const DEEPSEEK_CMD = process.env.DEEPSEEK_CMD || "deepseek";
const CODEBASE_PATH = path.resolve(
  process.env.CODEBASE_PATH || path.join(__dirname, ".."),
);
const LOG_DIR = path.join(__dirname, "issue-logs");
const POLL_MS = Number(process.env.POLL_INTERVAL_MS) || 5_000;
const ACTIVE_MS = Number(process.env.POLL_INTERVAL_ACTIVE_MS) || 1_000;

let running = true;

fs.mkdirSync(LOG_DIR, { recursive: true });

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
  log(`Processing issue ${issue.id}: ${issue.summary}`);

  const prompt = formatPrompt(issue);
  const file = logFilename(issue.id);

  let stdout = "";
  let stderr = "";

  await new Promise((resolve) => {
    const child = spawn(DEEPSEEK_CMD, ["chat", prompt], {
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
      } else {
        log(`DeepSeek exited with code ${code} for issue ${issue.id}`);
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
