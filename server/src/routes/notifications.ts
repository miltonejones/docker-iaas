import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import express, { type Request, type Response } from 'express';
import { requireAuth, optionalAuth } from '../auth.js';

export const notificationsRouter = express.Router();

// The consumer/issue-tracker writes one JSON line per event to this log
// (see scripts/issue-consumer.mjs). The desktop notify-watcher.mjs script
// SSH-tails this same file to fire local notify-send popups; this router
// exposes the same event stream to the web UI so a browser-side panel can
// stay in sync without a separate watcher process.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOTIFY_LOG = path.join(__dirname, '..', '..', '..', 'scripts', 'issue-logs', 'notifications.jsonl');

const POLL_MS = 2000;
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

/** Return the most recent notifications (newest last). */
notificationsRouter.get('/', requireAuth, (req: Request, res: Response) => {
  const entries = readEntries();
  res.json({ entries: entries.slice(-MAX_HISTORY) });
});

/** Clear the entire notification log. */
notificationsRouter.delete('/', requireAuth, (_req: Request, res: Response) => {
  try {
    fs.writeFileSync(NOTIFY_LOG, '', 'utf8');
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Accept a notification event from an external consumer (e.g. the containerized
 *  issue-consumer) and append it to the shared log so the SSE stream and the
 *  web UI pick it up in real time without a host volume mount. */
notificationsRouter.post('/', optionalAuth, (req: Request, res: Response) => {
  const entry = req.body;
  if (!entry || !entry.ts || !entry.summary) {
    return res.status(400).json({ error: 'Invalid notification entry — required fields: ts, summary' });
  }
  const line = JSON.stringify(entry) + '\n';
  try {
    fs.appendFileSync(NOTIFY_LOG, line, 'utf8');
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** SSE stream — polls the log file for growth and pushes new lines only. */
notificationsRouter.get('/stream', requireAuth, (req: Request, res: Response) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  let alive = true;
  let lastSize = 0;
  try {
    lastSize = fs.statSync(NOTIFY_LOG).size;
  } catch {
    lastSize = 0;
  }

  // Send recent history as catch-up so the panel isn't empty on load.
  const send = (data: Record<string, unknown>) => {
    if (!alive) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  send({ type: 'history', entries: readEntries().slice(-MAX_HISTORY) });

  const poll = () => {
    if (!alive) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(NOTIFY_LOG);
    } catch {
      return;
    }
    // Log was truncated/rotated — resync from the top.
    if (stat.size < lastSize) lastSize = 0;
    if (stat.size === lastSize) return;

    const fd = fs.openSync(NOTIFY_LOG, 'r');
    try {
      const length = stat.size - lastSize;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, lastSize);
      lastSize = stat.size;
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          send({ type: 'entry', entry: JSON.parse(line) as NotificationEntry });
        } catch {
          // skip unparseable lines
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  };

  const timer = setInterval(poll, POLL_MS);

  req.on('close', () => {
    alive = false;
    clearInterval(timer);
    res.end();
  });
});
