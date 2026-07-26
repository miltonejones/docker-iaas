import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOTIFY_LOG = path.join(__dirname, '..', '..', '..', 'scripts', 'issue-logs', 'notifications.jsonl');

const MAX_HISTORY = 200;

export interface NotificationEntry {
  ts: string;
  level: string;
  summary: string;
  body?: string;
}

function readEntries(): NotificationEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(NOTIFY_LOG, 'utf8');
  } catch {
    return [];
  }
  const entries: NotificationEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip unparseable lines
    }
  }
  return entries;
}

export function list(): { entries: NotificationEntry[] } {
  const entries = readEntries();
  return { entries: entries.slice(-MAX_HISTORY) };
}

export function clear(): void {
  fs.writeFileSync(NOTIFY_LOG, '', 'utf8');
}

export function post(entry: NotificationEntry): void {
  if (!entry || !entry.ts || !entry.summary) {
    throw new Error('Invalid notification entry — required fields: ts, summary');
  }
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(NOTIFY_LOG, line, 'utf8');
}
