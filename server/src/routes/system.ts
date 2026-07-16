import { Router, type Request, type Response } from 'express';
import { pingDocker, docker } from '../docker.js';
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

// Return host ports currently published by running containers, so the launch
// flow can warn about conflicts before creating a new container.
// Build-cache detail extracted from docker system df.
systemRouter.get('/build-cache', async (_req: Request, res: Response) => {
  try {
    const data: any = await new Promise((resolve, reject) => {
      (docker as any).modem.dial(
        { method: 'GET', path: '/system/df', statusCodes: { 200: true } },
        (err: unknown, result: any) => (err ? reject(err) : resolve(result)),
      );
    });
    const entries = (data?.BuildCache || []).map((e: any) => ({
      id: e.ID?.slice(0, 12) || '',
      type: e.Type || '',
      description: e.Description || '',
      size: e.Size || 0,
      created: e.CreatedAt || '',
      inUse: e.InUse || false,
      shared: e.Shared || false,
    }));
    res.json(entries);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Prune build cache.
systemRouter.post('/build-cache/prune', async (_req: Request, res: Response) => {
  try {
    const data: any = await new Promise((resolve, reject) => {
      (docker as any).modem.dial(
        { method: 'POST', path: '/build/prune?all=true', statusCodes: { 200: true } },
        (err: unknown, result: any) => (err ? reject(err) : resolve(result)),
      );
    });
    res.json({
      ok: true,
      reclaimedBytes: data?.SpaceReclaimed || 0,
      cachesDeleted: data?.CachesDeleted?.length || 0,
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

systemRouter.get('/used-ports', async (_req: Request, res: Response) => {
  try {
    const list = await docker.listContainers({ all: true });
    const used = new Set<number>();
    for (const c of list) {
      for (const p of c.Ports || []) {
        if (p.PublicPort) used.add(p.PublicPort);
      }
    }
    res.json({ ports: Array.from(used).sort((a, b) => a - b) });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
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
