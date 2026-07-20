import { Router, type Request, type Response } from 'express';
import { getAuthUser } from '../auth.js';
import {
  createDatabaseConnection,
  createDatabaseJob,
  createDatabaseOperation,
  deleteDatabaseConnection,
  getDatabaseConnection,
  getDatabaseJob,
  updateDatabaseConnection,
  updateDatabaseJob,
  updateDatabaseOperation,
} from '../db.js';
import {
  DATABASE_MASTER_KEY_ERROR,
  HttpError,
  applyConnectionUpdate,
  executeBackupJob,
  executeConfirmedGrant,
  executeConfirmedMigration,
  executeConfirmedMutation,
  executeRestoreJob,
  getConnectionDetail,
  getJobArtifactDownload,
  getOperationsOverview,
  listConnectionDetails,
  listJobOverviews,
  listOperationOverviews,
  newConnectionId,
  newJobId,
  newOperationId,
  normalizeConnectionInput,
  previewMigration,
  previewMutation,
  serializeConnectionForStorage,
  testSavedConnection,
  inspectSavedConnectionSchema,
  listOperationHistory,
  runSavedConnectionRead,
  ensureConnectionId,
  ensureJobId,
  ensureManagedIdentifier,
  type BackupRequest,
  type RestoreRequest,
  previewGrant,
} from '../databaseManagement.js';

export const databasesRouter = Router();

function statusForError(err: unknown): number {
  return err instanceof HttpError ? err.status : 502;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

function sendError(res: Response, err: unknown): void {
  res.status(statusForError(err)).json({ error: errorMessage(err) });
}

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value };
  return value as Record<string, unknown>;
}

function queryLimit(value: unknown, fallback = 25): number {
  const num = Number(value ?? fallback);
  if (!Number.isInteger(num) || num < 1 || num > 100) {
    throw new HttpError(400, 'limit must be an integer between 1 and 100.');
  }
  return num;
}

function requireExistingConnection(id: string) {
  const row = getDatabaseConnection(ensureConnectionId(id));
  if (!row) throw new HttpError(404, 'Saved database connection not found.');
  return row;
}

databasesRouter.get('/overview', (_req: Request, res: Response) => {
  try {
    res.json(getOperationsOverview());
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.get('/connections', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(listConnectionDetails(userId));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.post('/connections', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const normalized = normalizeConnectionInput(req.body);
    const stored = serializeConnectionForStorage(normalized.config);
    const row = createDatabaseConnection(
      newConnectionId(),
      normalized.name,
      normalized.engine,
      stored.summaryJson,
      stored.encryptedConfig,
      userId,
    );
    res.status(201).json(getConnectionDetail(row.id, userId));
  } catch (err) {
    if (errorMessage(err) === DATABASE_MASTER_KEY_ERROR) {
      res.status(503).json({ error: DATABASE_MASTER_KEY_ERROR });
      return;
    }
    sendError(res, err);
  }
});

databasesRouter.get('/connections/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(getConnectionDetail(req.params.id, userId));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.put('/connections/:id', (req: Request, res: Response) => {
  try {
    const existing = requireExistingConnection(req.params.id);
    const normalized = applyConnectionUpdate(existing, req.body);
    const stored = serializeConnectionForStorage(normalized.config);
    const updated = updateDatabaseConnection(existing.id, {
      name: normalized.name,
      engine: normalized.engine,
      summaryJson: stored.summaryJson,
      encryptedConfig: stored.encryptedConfig,
    });
    if (!updated) throw new HttpError(404, 'Saved database connection not found.');
    res.json(getConnectionDetail(updated.id));
  } catch (err) {
    if (errorMessage(err) === DATABASE_MASTER_KEY_ERROR) {
      res.status(503).json({ error: DATABASE_MASTER_KEY_ERROR });
      return;
    }
    sendError(res, err);
  }
});

databasesRouter.delete('/connections/:id', (req: Request, res: Response) => {
  try {
    const deleted = deleteDatabaseConnection(ensureConnectionId(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: 'Saved database connection not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.post('/connections/:id/test', async (req: Request, res: Response) => {
  try {
    res.json(await testSavedConnection(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.get('/connections/:id/schema', async (req: Request, res: Response) => {
  try {
    res.json(await inspectSavedConnectionSchema(req.params.id, req.query.database));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.post('/connections/:id/read', async (req: Request, res: Response) => {
  try {
    res.json(await runSavedConnectionRead(req.params.id, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.post('/connections/:id/grant', async (req: Request, res: Response) => {
  try {
    const preview = previewGrant(req.params.id, req.body);
    if ((req.body as { confirmed?: boolean } | undefined)?.confirmed !== true) {
      res.json({
        requiresConfirmation: true,
        category: 'grant',
        operationHistory: listOperationHistory(req.params.id, 10),
        ...preview,
      });
      return;
    }

    const opId = newOperationId();
    createDatabaseOperation({
      id: opId,
      connectionId: ensureConnectionId(req.params.id),
      engine: getConnectionDetail(req.params.id).engine,
      category: 'grant',
      action: 'execute_database_access_grant',
      summary: preview.summary,
      status: 'running',
      requestJson: jsonString(preview.request),
    });

    try {
      const result = await executeConfirmedGrant(req.params.id, req.body);
      updateDatabaseOperation(opId, {
        status: 'completed',
        resultJson: jsonString(result),
        finishedAt: new Date().toISOString(),
      });
      const operationHistory = listOperationHistory(req.params.id, 10);
      res.json({ operationId: opId, operation: operationHistory[0] ?? null, operationHistory, ...asObject(result) });
    } catch (err) {
      updateDatabaseOperation(opId, {
        status: 'failed',
        error: errorMessage(err),
        finishedAt: new Date().toISOString(),
      });
      throw err;
    }
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.post('/connections/:id/mutate', async (req: Request, res: Response) => {
  try {
    const preview = previewMutation(req.params.id, req.body);
    if ((req.body as { confirmed?: boolean } | undefined)?.confirmed !== true) {
      res.json({ requiresConfirmation: true, category: 'mutation', ...preview });
      return;
    }

    const opId = newOperationId();
    createDatabaseOperation({
      id: opId,
      connectionId: ensureConnectionId(req.params.id),
      engine: getConnectionDetail(req.params.id).engine,
      category: 'mutation',
      action: 'execute_database_mutation',
      summary: preview.summary,
      status: 'running',
      requestJson: jsonString(preview.request),
    });

    try {
      const result = await executeConfirmedMutation(req.params.id, req.body);
      updateDatabaseOperation(opId, {
        status: 'completed',
        resultJson: jsonString(result),
        finishedAt: new Date().toISOString(),
      });
      res.json({ operationId: opId, ...asObject(result) });
    } catch (err) {
      updateDatabaseOperation(opId, {
        status: 'failed',
        error: errorMessage(err),
        finishedAt: new Date().toISOString(),
      });
      throw err;
    }
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.post('/connections/:id/migrate', async (req: Request, res: Response) => {
  try {
    const preview = previewMigration(req.params.id, req.body);
    if ((req.body as { confirmed?: boolean } | undefined)?.confirmed !== true) {
      res.json({ requiresConfirmation: true, category: 'migration', ...preview });
      return;
    }

    const opId = newOperationId();
    createDatabaseOperation({
      id: opId,
      connectionId: ensureConnectionId(req.params.id),
      engine: getConnectionDetail(req.params.id).engine,
      category: 'migration',
      action: 'execute_database_migration',
      summary: preview.summary,
      status: 'running',
      requestJson: jsonString(preview.request),
    });

    try {
      const result = await executeConfirmedMigration(req.params.id, req.body);
      updateDatabaseOperation(opId, {
        status: 'completed',
        resultJson: jsonString(result),
        finishedAt: new Date().toISOString(),
      });
      res.json({ operationId: opId, ...asObject(result) });
    } catch (err) {
      updateDatabaseOperation(opId, {
        status: 'failed',
        error: errorMessage(err),
        finishedAt: new Date().toISOString(),
      });
      throw err;
    }
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.get('/operations', (req: Request, res: Response) => {
  try {
    res.json(listOperationOverviews(queryLimit(req.query.limit)));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.get('/jobs', (req: Request, res: Response) => {
  try {
    res.json(listJobOverviews(queryLimit(req.query.limit)));
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.get('/jobs/:id', (req: Request, res: Response) => {
  try {
    const job = getDatabaseJob(ensureJobId(req.params.id));
    if (!job) {
      res.status(404).json({ error: 'Database job not found.' });
      return;
    }
    const full = listJobOverviews(500).find((entry) => (entry as { id: string }).id === job.id);
    res.json(full ?? job);
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.get('/jobs/:id/download', async (req: Request, res: Response) => {
  try {
    const artifact = await getJobArtifactDownload(req.params.id);
    res.setHeader('Content-Type', artifact.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.fileName}"`);
    res.send(artifact.body);
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.post('/connections/:id/backup', async (req: Request, res: Response) => {
  try {
    requireExistingConnection(req.params.id);
    const body = req.body as BackupRequest;
    const database = body.database !== undefined ? ensureManagedIdentifier(body.database, 'database') : undefined;
    const preview = {
      summary: `Create backup for ${getConnectionDetail(req.params.id).name}${database ? ` (${database})` : ''}`,
      request: { database },
    };
    if (body.confirmed !== true) {
      res.json({ requiresConfirmation: true, category: 'backup', ...preview });
      return;
    }

    const jobId = newJobId();
    createDatabaseJob({
      id: jobId,
      connectionId: ensureConnectionId(req.params.id),
      engine: getConnectionDetail(req.params.id).engine,
      kind: 'backup',
      summary: preview.summary,
      status: 'running',
      requestJson: jsonString(preview.request),
    });

    try {
      const result = await executeBackupJob(req.params.id, jobId, body);
      updateDatabaseJob(jobId, {
        status: 'completed',
        artifactFormat: result.artifactFormat,
        artifactPath: result.artifactPath,
        artifactSize: result.artifactSize,
        resultJson: jsonString(result.result),
        finishedAt: new Date().toISOString(),
      });
      res.json({ jobId, ...asObject(result.result), artifactFormat: result.artifactFormat, artifactSize: result.artifactSize });
    } catch (err) {
      updateDatabaseJob(jobId, {
        status: 'failed',
        error: errorMessage(err),
        finishedAt: new Date().toISOString(),
      });
      throw err;
    }
  } catch (err) {
    sendError(res, err);
  }
});

databasesRouter.post('/connections/:id/restore', async (req: Request, res: Response) => {
  try {
    requireExistingConnection(req.params.id);
    const body = req.body as RestoreRequest;
    const jobId = ensureJobId(body.jobId);
    const source = getDatabaseJob(jobId);
    if (!source) throw new HttpError(404, 'Backup job not found.');
    const targetDatabase = body.targetDatabase !== undefined ? ensureManagedIdentifier(body.targetDatabase, 'targetDatabase') : undefined;
    const preview = {
      summary: `Restore ${jobId} into ${getConnectionDetail(req.params.id).name}${targetDatabase ? ` (${targetDatabase})` : ''}`,
      request: { jobId, targetDatabase },
    };
    if (body.confirmed !== true) {
      res.json({ requiresConfirmation: true, category: 'restore', ...preview });
      return;
    }

    const restoreJobId = newJobId();
    createDatabaseJob({
      id: restoreJobId,
      connectionId: ensureConnectionId(req.params.id),
      engine: getConnectionDetail(req.params.id).engine,
      kind: 'restore',
      summary: preview.summary,
      status: 'running',
      requestJson: jsonString(preview.request),
    });

    try {
      const result = await executeRestoreJob(req.params.id, body);
      updateDatabaseJob(restoreJobId, {
        status: 'completed',
        resultJson: jsonString(result),
        finishedAt: new Date().toISOString(),
      });
      res.json({ jobId: restoreJobId, sourceJobId: jobId, ...asObject(result) });
    } catch (err) {
      updateDatabaseJob(restoreJobId, {
        status: 'failed',
        error: errorMessage(err),
        finishedAt: new Date().toISOString(),
      });
      throw err;
    }
  } catch (err) {
    sendError(res, err);
  }
});
