import { Router, type Request, type Response } from 'express';
import { getAuthUser } from '../auth.js';
import * as assistantsService from '../services/assistants.js';

function sendError(res: Response, err: unknown) {
  const status = (err as { status?: number }).status || 500;
  res.status(status).json({ error: (err as Error).message || 'Unknown error.' });
}

export const assistantsRouter = Router();

assistantsRouter.get('/', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }
    res.json(assistantsService.list(userId));
  } catch (err) { sendError(res, err); }
});

assistantsRouter.get('/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }
    res.json(assistantsService.get(req.params.id, userId));
  } catch (err) { sendError(res, err); }
});

assistantsRouter.post('/', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }
    res.status(201).json(assistantsService.create(userId, req.body));
  } catch (err) { sendError(res, err); }
});

assistantsRouter.put('/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }
    res.json(assistantsService.update(req.params.id, userId, req.body));
  } catch (err) { sendError(res, err); }
});

assistantsRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }
    res.json(assistantsService.remove(req.params.id, userId));
  } catch (err) { sendError(res, err); }
});
