import { Router, type Request, type Response } from 'express';
import { requireRole } from '../auth.js';
import { HttpError } from '../services/HttpError.js';
import * as imageService from '../services/images.js';

export const imagesRouter = Router();

function sendError(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 502;
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unknown error.' });
}

imagesRouter.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await imageService.list());
  } catch (err) {
    sendError(res, err);
  }
});

imagesRouter.delete('/:id', async (req: Request, res: Response) => {
  const force = req.query.force === 'true';
  try {
    await imageService.remove(req.params.id, force);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Prune reclaimable space (dangling images + stopped containers).
imagesRouter.post('/prune', requireRole('admin'), async (_req: Request, res: Response) => {
  try {
    res.json(await imageService.prune());
  } catch (err) {
    sendError(res, err);
  }
});
