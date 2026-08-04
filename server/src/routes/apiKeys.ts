import { Router, type Response } from 'express';
import { getAuthUser } from '../auth.js';
import { HttpError } from '../services/HttpError.js';
import * as apiKeyService from '../services/apiKeys.js';

export const apiKeysRouter = Router();

function sendError(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unknown error.' });
}

apiKeysRouter.get('/', (req, res) => {
  try {
    res.json(apiKeyService.list(getAuthUser(req)!.userId));
  } catch (err) {
    sendError(res, err);
  }
});

apiKeysRouter.post('/', (req, res) => {
  try {
    const { name } = req.body as { name?: string };
    res.status(201).json(apiKeyService.create(getAuthUser(req)!.userId, name ?? ''));
  } catch (err) {
    sendError(res, err);
  }
});

apiKeysRouter.delete('/:id', (req, res) => {
  try {
    apiKeyService.revoke(getAuthUser(req)!.userId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});
