import { Router, type Request, type Response } from 'express';
import { HttpError } from '../services/HttpError.js';
import * as volumeService from '../services/volumes.js';

export const volumesRouter = Router();

function sendError(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 502;
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unknown error.' });
}

volumesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await volumeService.list());
  } catch (err) {
    sendError(res, err);
  }
});

volumesRouter.get('/:name', async (req: Request, res: Response) => {
  try {
    res.json(await volumeService.inspect(req.params.name));
  } catch (err) {
    sendError(res, err);
  }
});

volumesRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { name, driver, labels } = req.body as { name?: string; driver?: string; labels?: Record<string, string> };
    if (!name || !name.trim()) {
      res.status(400).json({ error: 'Volume name is required.' });
      return;
    }
    res.status(201).json(await volumeService.create({ name: name.trim(), driver, labels }));
  } catch (err) {
    sendError(res, err);
  }
});

volumesRouter.delete('/:name', async (req: Request, res: Response) => {
  try {
    await volumeService.remove(req.params.name, req.query.force === 'true');
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

volumesRouter.post('/prune', async (_req: Request, res: Response) => {
  try {
    res.json(await volumeService.prune());
  } catch (err) {
    sendError(res, err);
  }
});
