import { Router, type Request, type Response } from 'express';
import { getAuthUser } from '../auth.js';
import { HttpError } from '../services/HttpError.js';
import * as projectService from '../services/projects.js';

export const projectsRouter = Router();

function sendError(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unknown error.' });
}

projectsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(await projectService.list(userId));
  } catch (err) {
    sendError(res, err);
  }
});

projectsRouter.post('/', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }

    const { name, description } = req.body as { name?: string; description?: string };
    const result = projectService.create(userId, { name: name || '', description });
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

projectsRouter.get('/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(projectService.get(req.params.id, userId));
  } catch (err) {
    sendError(res, err);
  }
});

projectsRouter.put('/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }
    const { name, description } = req.body as { name?: string; description?: string };
    res.json(projectService.update(req.params.id, userId, { name, description }));
  } catch (err) {
    sendError(res, err);
  }
});

projectsRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    projectService.remove(req.params.id, userId);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

projectsRouter.put('/:id/resources', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }

    const { resourceTable, resourceId } = req.body as {
      resourceTable?: string;
      resourceId?: string;
    };
    res.json(await projectService.linkResource(req.params.id, userId, resourceTable || '', resourceId || ''));
  } catch (err) {
    sendError(res, err);
  }
});

projectsRouter.delete('/:id/resources', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!userId) { res.status(401).json({ error: 'Authentication required.' }); return; }

    const resourceTable = typeof req.query.resourceTable === 'string' ? req.query.resourceTable : '';
    const resourceId = typeof req.query.resourceId === 'string' ? req.query.resourceId.trim() : '';
    res.json(await projectService.unlinkResource(req.params.id, userId, resourceTable, resourceId));
  } catch (err) {
    sendError(res, err);
  }
});
