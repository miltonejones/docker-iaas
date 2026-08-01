import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { requireAuth, optionalAuth } from '../auth.js';
import * as notificationService from '../services/notifications.js';
import type { NotificationEntry } from '../services/notifications.js';

export const notificationsRouter = express.Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOTIFY_LOG = path.join(__dirname, '..', '..', '..', 'scripts', 'issue-logs', 'notifications.jsonl');

const POLL_MS = 2000;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- TODO(gap-00)
const MAX_HISTORY = 200;

/** Return the most recent notifications (newest last). */
notificationsRouter.get('/', requireAuth, (req: Request, res: Response) => {
  res.json(notificationService.list());
});

/** Clear the entire notification log. */
notificationsRouter.delete('/', requireAuth, (_req: Request, res: Response) => {
  try {
    notificationService.clear();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Accept a notification event from an external consumer (e.g. the containerized
 *  issue-consumer) and append it to the shared log so the SSE stream and the
 *  web UI pick it up in real time without a host volume mount. */
notificationsRouter.post('/', optionalAuth, (req: Request, res: Response) => {
  try {
    notificationService.post(req.body as NotificationEntry);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.message?.startsWith('Invalid') ? 400 : 500).json({ error: err.message });
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
  send({ type: 'history', entries: notificationService.list().entries });

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
