import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../auth.js';
import { getWebhookSecret, rotateWebhookSecret } from '../auth.js';
import { HttpError } from '../services/HttpError.js';
import * as systemService from '../services/system.js';

export const systemRouter = Router();

const POLL_MS = Number(process.env.USAGE_POLL_MS || 5000);

function sendError(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 502;
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unknown error.' });
}

systemRouter.get('/ping', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json(await systemService.ping());
  } catch (err) {
    sendError(res, err);
  }
});

systemRouter.get('/presets', requireAuth, (_req: Request, res: Response) => {
  res.json(systemService.presets());
});

systemRouter.get('/usage', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json(await systemService.usage());
  } catch (err) {
    sendError(res, err);
  }
});

systemRouter.get('/build-cache', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json(await systemService.buildCache());
  } catch (err) {
    sendError(res, err);
  }
});

systemRouter.post('/build-cache/prune', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json(await systemService.pruneBuildCache());
  } catch (err) {
    sendError(res, err);
  }
});

systemRouter.get('/used-ports', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json(await systemService.usedPorts());
  } catch (err) {
    sendError(res, err);
  }
});

// Continuous usage reporting over Server-Sent Events. The dashboard subscribes
// once and receives a fresh disk/Docker usage snapshot every POLL_MS, so usage
// stays live without the client hammering the REST endpoint.
systemRouter.get('/usage/stream', async (req: Request, res: Response) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  let alive = true;
  const send = async () => {
    if (!alive) return;
    try {
      const snapshot = await systemService.usage();
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    } catch {
      /* keep the stream open even if one poll fails */
    }
  };

  await send();
  const timer = setInterval(send, POLL_MS);

  req.on('close', () => {
    alive = false;
    clearInterval(timer);
    res.end();
  });
});

// GET /api/system/audit?limit=50
systemRouter.get('/audit', requireAuth, (req: Request, res: Response) => {
  try {
    const raw = req.query.limit;
    const limit = typeof raw === 'string' ? Math.min(Math.max(1, parseInt(raw, 10) || 50), 1000) : 50;
    res.json(systemService.audit(limit));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/system/webhook-secret
systemRouter.get('/webhook-secret', requireAuth, (_req: Request, res: Response) => {
  const secret = getWebhookSecret();
  if (!secret) return res.status(404).json({ error: 'No webhook secret configured.' });
  res.json({ secret });
});

// POST /api/system/webhook-secret/rotate
systemRouter.post('/webhook-secret/rotate', requireAuth, (_req: Request, res: Response) => {
  const secret = rotateWebhookSecret();
  res.json({ secret });
});
