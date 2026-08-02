import { Router, type Request, type Response, type NextFunction } from 'express';
import { getAuthUser, requireRole } from '../auth.js';
import { HttpError } from '../services/HttpError.js';
import * as databaseService from '../services/databases.js';
import { assertNotProtected, checkProtectedWarning } from '../services/projects.js';

export const databasesRouter = Router();

function sendError(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 502;
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unknown error.' });
}

function queryLimit(value: unknown, fallback = 25): number {
  const num = Number(value ?? fallback);
  if (!Number.isInteger(num) || num < 1 || num > 100) {
    throw new HttpError(400, 'limit must be an integer between 1 and 100.');
  }
  return num;
}

/** Escalate to admin if `req.body.confirmed === true`.  Assumes `requireAuth` already ran. */
function requireAdminIfConfirmed(req: Request, res: Response, next: NextFunction): void {
  if (req.body?.confirmed === true) {
    requireRole('admin')(req, res, next);
  } else {
    next();
  }
}

// ── Overview ──────────────────────────────────────────────────

databasesRouter.get('/overview', requireRole('operator'), (_req: Request, res: Response) => {
  try {
    res.json(databaseService.listOperations());
  } catch (err) {
    sendError(res, err);
  }
});

// ── Connections CRUD ──────────────────────────────────────────

databasesRouter.get('/connections', requireRole('operator'), (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : undefined;
    res.json(databaseService.listConnections(userId, projectId));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.post('/connections', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const projectId = (req.body as { projectId?: string }).projectId?.trim() || undefined;
    const result = databaseService.createConnection(userId, req.body, projectId);
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.get('/connections/:id', requireRole('operator'), (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(databaseService.getConnection(req.params.id, userId));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.put('/connections/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    res.json(databaseService.updateConnection(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.delete('/connections/:id', requireRole('admin'), (req: Request, res: Response) => {
  try {
    // requireRole('admin') already lets admins through, so this is a no-op today —
    // kept for consistency in case this endpoint's role requirement ever loosens.
    assertNotProtected('databases', req.params.id, req.authUser?.role);
    const warning = checkProtectedWarning('databases', req.params.id);
    databaseService.deleteConnection(req.params.id);
    res.json({ ok: true, ...(warning ? { warning } : {}) });
  } catch (err) {
    sendError(res, err);
  }
});

// ── Connection actions ────────────────────────────────────────

databasesRouter.post('/connections/:id/test', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    res.json(await databaseService.testConnection(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.get('/connections/:id/schema', requireRole('operator'), async (req: Request, res: Response) => {
  try {
    res.json(await databaseService.inspectSchema(req.params.id, req.query.database));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.post('/connections/:id/read', requireRole('operator'), async (req: Request, res: Response) => {
  try {
    res.json(await databaseService.runRead(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Grant ─────────────────────────────────────────────────────

databasesRouter.post('/connections/:id/grant', requireRole('operator'), requireAdminIfConfirmed, async (req: Request, res: Response) => {
  try {
    res.json(await databaseService.executeGrant(req.params.id, req.body, getAuthUser(req)?.userId));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Mutate ────────────────────────────────────────────────────

databasesRouter.post('/connections/:id/mutate', requireRole('operator'), requireAdminIfConfirmed, async (req: Request, res: Response) => {
  try {
    res.json(await databaseService.executeMutation(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Migrate ───────────────────────────────────────────────────

databasesRouter.post('/connections/:id/migrate', requireRole('operator'), requireAdminIfConfirmed, async (req: Request, res: Response) => {
  try {
    res.json(await databaseService.executeMigration(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Operations ────────────────────────────────────────────────

databasesRouter.get('/operations', requireRole('operator'), (req: Request, res: Response) => {
  try {
    res.json(databaseService.listOperationHistoryList(queryLimit(req.query.limit)));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Jobs ──────────────────────────────────────────────────────

databasesRouter.get('/jobs', requireRole('operator'), (req: Request, res: Response) => {
  try {
    res.json(databaseService.listJobs(queryLimit(req.query.limit)));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.get('/jobs/:id', requireRole('operator'), (req: Request, res: Response) => {
  try {
    res.json(databaseService.getJob(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.get('/jobs/:id/download', requireRole('operator'), async (req: Request, res: Response) => {
  try {
    const artifact = await databaseService.getJobArtifactDownloadData(req.params.id);
    res.setHeader('Content-Type', artifact.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.fileName}"`);
    res.send(artifact.body);
  } catch (err) {
    sendError(res, err);
  }
});

// ── Backup / Restore ──────────────────────────────────────────

databasesRouter.post('/connections/:id/backup', requireRole('operator'), requireAdminIfConfirmed, async (req: Request, res: Response) => {
  try {
    res.json(await databaseService.createBackup(req.params.id, req.body, getAuthUser(req)?.userId));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.post('/connections/:id/restore', requireRole('operator'), requireAdminIfConfirmed, async (req: Request, res: Response) => {
  try {
    res.json(await databaseService.restoreBackup(req.params.id, req.body, getAuthUser(req)?.userId));
  } catch (err) {
    sendError(res, err);
  }
});
