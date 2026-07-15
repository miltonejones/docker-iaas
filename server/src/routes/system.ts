import { Router, type Request, type Response } from 'express';
import { pingDocker } from '../docker.js';
import { PRESETS } from '../presets.js';
import { getUsageSnapshot } from '../usage.js';

export const systemRouter = Router();

const POLL_MS = Number(process.env.USAGE_POLL_MS || 5000);

systemRouter.get('/ping', async (_req: Request, res: Response) => {
  res.json(await pingDocker());
});

systemRouter.get('/presets', (_req: Request, res: Response) => {
  res.json(PRESETS);
});

// One-shot usage snapshot.
systemRouter.get('/usage', async (_req: Request, res: Response) => {
  res.json(await getUsageSnapshot());
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
      const snapshot = await getUsageSnapshot();
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
