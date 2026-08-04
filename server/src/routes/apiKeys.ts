import { Router } from 'express';
import { getAuthUser } from '../auth.js';
import * as apiKeyService from '../services/apiKeys.js';

export const apiKeysRouter = Router();

apiKeysRouter.get('/', (req, res) => {
  res.json(apiKeyService.list(getAuthUser(req)!.userId));
});

apiKeysRouter.post('/', (req, res) => {
  const { name } = req.body as { name?: string };
  res.status(201).json(apiKeyService.create(getAuthUser(req)!.userId, name ?? ''));
});

apiKeysRouter.delete('/:id', (req, res) => {
  apiKeyService.revoke(getAuthUser(req)!.userId, req.params.id);
  res.json({ ok: true });
});
