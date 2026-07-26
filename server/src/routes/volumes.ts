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
