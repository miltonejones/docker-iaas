#!/usr/bin/env node
// Tails the EC2 consumer's notification log and fires local notify-send for
// each event.  Run this on your laptop whenever you want to see consumer
// activity as desktop notifications.
//
//   node scripts/notify-watcher.mjs
//
// Ctrl-C to stop.
//
// Environment variables:
//   EC2_HOST       – SSH host (default: ec2-user@54.162.111.41)
//   EC2_KEY        – SSH key file  (default: ~/.ssh/dockyard-key.pem)
//   NOTIFY_LOG     – remote log path (default: /home/ec2-user/docker-iaas/scripts/issue-logs/notifications.jsonl)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EC2_HOST = process.env.EC2_HOST || "ec2-user@54.162.111.41";
const EC2_KEY =
  process.env.EC2_KEY ||
  path.join(process.env.HOME || "/home/miltonejones", ".ssh", "dockyard-key.pem");
const REMOTE_LOG =
  process.env.NOTIFY_LOG ||
  "/home/ec2-user/docker-iaas/scripts/issue-logs/notifications.jsonl";

// Icon mapping by notification prefix
function pickIcon(summary) {
  if (summary.startsWith("🐛")) return "dialog-warning";
  if (summary.startsWith("🚀")) return "network-transmit";
  if (summary.startsWith("✅")) return "emblem-ok";
  if (summary.startsWith("❌")) return "dialog-error";
  if (summary.startsWith("⏭️")) return "edit-clear";
  return "dialog-information";
}

function sendNotify(summary, body) {
  const n = spawn(
    "notify-send",
    ["--app-name=Dockyard", "--icon=" + pickIcon(summary), summary, body],
    { stdio: "ignore", detached: true },
  );
  n.unref();
}

function log(...args) {
  const ts = new Date().toISOString().split("T")[1].slice(0, 12);
  console.log(`[${ts}]`, ...args);
}

log(`Connecting to ${EC2_HOST}...`);

// ssh tail the remote notification log
const ssh = spawn("ssh", [
  "-i", EC2_KEY,
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ConnectTimeout=15",
  "-o", "ServerAliveInterval=60",
  EC2_HOST,
  `tail -n 0 -F '${REMOTE_LOG}'`,
], { stdio: ["ignore", "pipe", "pipe"] });

// Buffer for partial lines
let buf = "";

ssh.stdout.on("data", (d) => {
  buf += d.toString();
  const lines = buf.split("\n");
  buf = lines.pop(); // keep the last incomplete line

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      log(`${ev.level} | ${ev.summary}`);
      sendNotify(ev.summary, ev.body);
    } catch {
      // skip unparseable lines
    }
  }
});

ssh.stderr.on("data", (d) => {
  process.stderr.write(`[ssh] ${d}`);
});

ssh.once("close", (code) => {
  log(`SSH disconnected (exit ${code}).`);
  process.exit(code || 1);
});

process.on("SIGINT", () => { ssh.kill(); process.exit(0); });
process.on("SIGTERM", () => { ssh.kill(); process.exit(0); });
