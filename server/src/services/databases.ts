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
} from '../db/databaseOps.js';
import { getProject } from '../db.js';
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
import { recordAuditLog } from '../db/audit.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error.';
}

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value };
  return value as Record<string, unknown>;
}

export function listConnections(userId?: string, projectId?: string) {
  return listConnectionDetails(userId, projectId);
}

export function getConnection(id: string, userId?: string) {
  return getConnectionDetail(id, userId);
}

export function createConnection(
  userId: string | undefined,
  input: Record<string, unknown>,
  projectId?: string,
) {
  const normalized = normalizeConnectionInput(input);
  const stored = serializeConnectionForStorage(normalized.config);

  if (projectId) {
    const project = getProject(projectId, userId);
    if (!project) throw new HttpError(400, 'Project not found.');
  }

  try {
    const row = createDatabaseConnection(
      newConnectionId(),
      normalized.name,
      normalized.engine,
      stored.summaryJson,
      stored.encryptedConfig,
      userId,
      projectId || null,
    );
    return getConnectionDetail(row.id, userId);
  } catch (err) {
    if (errorMessage(err) === DATABASE_MASTER_KEY_ERROR) {
      throw new HttpError(503, DATABASE_MASTER_KEY_ERROR);
    }
    throw err;
  }
}

export function updateConnection(id: string, input: Record<string, unknown>) {
  const existing = getDatabaseConnection(ensureConnectionId(id));
  if (!existing) throw new HttpError(404, 'Saved database connection not found.');

  const normalized = applyConnectionUpdate(existing, input);
  const stored = serializeConnectionForStorage(normalized.config);

  try {
    const updated = updateDatabaseConnection(existing.id, {
      name: normalized.name,
      engine: normalized.engine,
      summaryJson: stored.summaryJson,
      encryptedConfig: stored.encryptedConfig,
    });
    if (!updated) throw new HttpError(404, 'Saved database connection not found.');
    return getConnectionDetail(updated.id);
  } catch (err) {
    if (errorMessage(err) === DATABASE_MASTER_KEY_ERROR) {
      throw new HttpError(503, DATABASE_MASTER_KEY_ERROR);
    }
    throw err;
  }
}

export function deleteConnection(id: string) {
  const deleted = deleteDatabaseConnection(ensureConnectionId(id));
  if (!deleted) throw new HttpError(404, 'Saved database connection not found.');
}

export async function testConnection(id: string) {
  return testSavedConnection(id);
}

export async function inspectSchema(id: string, database?: unknown) {
  return inspectSavedConnectionSchema(id, database);
}

export async function runRead(id: string, body: unknown) {
  return runSavedConnectionRead(id, body);
}

export function previewGrantOp(id: string, body: unknown) {
  return previewGrant(id, body);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- TODO(gap-00)
export async function executeGrant(id: string, body: Record<string, unknown>, userId?: string) {
  const preview = previewGrant(id, body);
  if (body.confirmed !== true) {
    return { requiresConfirmation: true, category: 'grant', operationHistory: listOperationHistory(id, 10), ...preview };
  }

  const opId = newOperationId();
  createDatabaseOperation({
    id: opId,
    connectionId: ensureConnectionId(id),
    engine: getConnectionDetail(id).engine,
    category: 'grant',
    action: 'execute_database_access_grant',
    summary: preview.summary,
    status: 'running',
    requestJson: jsonString(preview.request),
  });

  try {
    const result = await executeConfirmedGrant(id, body);
    updateDatabaseOperation(opId, {
      status: 'completed',
      resultJson: jsonString(result),
      finishedAt: new Date().toISOString(),
    });
    const operationHistory = listOperationHistory(id, 10);
    recordAuditLog('database.grant', 'database_connection', id, null, null);
    return { operationId: opId, operation: operationHistory[0] ?? null, operationHistory, ...asObject(result) };
  } catch (err) {
    updateDatabaseOperation(opId, {
      status: 'failed',
      error: errorMessage(err),
      finishedAt: new Date().toISOString(),
    });
    throw err;
  }
}

export function previewMutationOp(id: string, body: unknown) {
  return previewMutation(id, body);
}

export async function executeMutation(id: string, body: Record<string, unknown>) {
  const preview = previewMutation(id, body);
  if (body.confirmed !== true) {
    return { requiresConfirmation: true, category: 'mutation', ...preview };
  }

  const opId = newOperationId();
  createDatabaseOperation({
    id: opId,
    connectionId: ensureConnectionId(id),
    engine: getConnectionDetail(id).engine,
    category: 'mutation',
    action: 'execute_database_mutation',
    summary: preview.summary,
    status: 'running',
    requestJson: jsonString(preview.request),
  });

  try {
    const result = await executeConfirmedMutation(id, body);
    updateDatabaseOperation(opId, {
      status: 'completed',
      resultJson: jsonString(result),
      finishedAt: new Date().toISOString(),
    });
    recordAuditLog('database.mutate', 'database_connection', id, null, null);
    recordAuditLog('database.migrate', 'database_connection', id, null, null);
    return { operationId: opId, ...asObject(result) };
  } catch (err) {
    updateDatabaseOperation(opId, {
      status: 'failed',
      error: errorMessage(err),
      finishedAt: new Date().toISOString(),
    });
    throw err;
  }
}

export function previewMigrationOp(id: string, body: unknown) {
  return previewMigration(id, body);
}

export async function executeMigration(id: string, body: Record<string, unknown>) {
  const preview = previewMigration(id, body);
  if (body.confirmed !== true) {
    return { requiresConfirmation: true, category: 'migration', ...preview };
  }

  const opId = newOperationId();
  createDatabaseOperation({
    id: opId,
    connectionId: ensureConnectionId(id),
    engine: getConnectionDetail(id).engine,
    category: 'migration',
    action: 'execute_database_migration',
    summary: preview.summary,
    status: 'running',
    requestJson: jsonString(preview.request),
  });

  try {
    const result = await executeConfirmedMigration(id, body);
    updateDatabaseOperation(opId, {
      status: 'completed',
      resultJson: jsonString(result),
      finishedAt: new Date().toISOString(),
    });
    return { operationId: opId, ...asObject(result) };
  } catch (err) {
    updateDatabaseOperation(opId, {
      status: 'failed',
      error: errorMessage(err),
      finishedAt: new Date().toISOString(),
    });
    throw err;
  }
}

export function listOperations() {
  return getOperationsOverview();
}

// ── Backup / Restore ──────────────────────────────────────────

export async function createBackup(
  connectionId: string,
  input: BackupRequest & Record<string, unknown>,
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- TODO(gap-00)
  userId?: string,
) {
  const existing = getDatabaseConnection(ensureConnectionId(connectionId));
  if (!existing) throw new HttpError(404, 'Saved database connection not found.');

  const database = input.database !== undefined
    ? ensureManagedIdentifier(input.database, 'database')
    : undefined;
  const preview = {
    summary: `Create backup for ${getConnectionDetail(connectionId).name}${database ? ` (${database})` : ''}`,
    request: { database },
  };
  if (input.confirmed !== true) {
    return { requiresConfirmation: true, category: 'backup', ...preview };
  }

  const jobId = newJobId();
  createDatabaseJob({
    id: jobId,
    connectionId: ensureConnectionId(connectionId),
    engine: getConnectionDetail(connectionId).engine,
    kind: 'backup',
    summary: preview.summary,
    status: 'running',
    requestJson: jsonString(preview.request),
  });

  try {
    const result = await executeBackupJob(connectionId, jobId, input);
    updateDatabaseJob(jobId, {
      status: 'completed',
      artifactFormat: result.artifactFormat,
      artifactPath: result.artifactPath,
      artifactSize: result.artifactSize,
      resultJson: jsonString(result.result),
      finishedAt: new Date().toISOString(),
    });
    recordAuditLog('database.backup', 'database_connection', connectionId, null, null);
    return {
      jobId,
      ...asObject(result.result),
      artifactFormat: result.artifactFormat,
      artifactSize: result.artifactSize,
    };
  } catch (err) {
    updateDatabaseJob(jobId, {
      status: 'failed',
      error: errorMessage(err),
      finishedAt: new Date().toISOString(),
    });
    throw err;
  }
}

export async function restoreBackup(
  connectionId: string,
  input: RestoreRequest & Record<string, unknown>,
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- TODO(gap-00)
  userId?: string,
) {
  const existing = getDatabaseConnection(ensureConnectionId(connectionId));
  if (!existing) throw new HttpError(404, 'Saved database connection not found.');

  const jobId = ensureJobId(input.jobId);
  const source = getDatabaseJob(jobId);
  if (!source) throw new HttpError(404, 'Backup job not found.');
  const targetDatabase = input.targetDatabase !== undefined
    ? ensureManagedIdentifier(input.targetDatabase, 'targetDatabase')
    : undefined;
  const preview = {
    summary: `Restore ${jobId} into ${getConnectionDetail(connectionId).name}${targetDatabase ? ` (${targetDatabase})` : ''}`,
    request: { jobId, targetDatabase },
  };
  if (input.confirmed !== true) {
    return { requiresConfirmation: true, category: 'restore', ...preview };
  }

  const restoreJobId = newJobId();
  createDatabaseJob({
    id: restoreJobId,
    connectionId: ensureConnectionId(connectionId),
    engine: getConnectionDetail(connectionId).engine,
    kind: 'restore',
    summary: preview.summary,
    status: 'running',
    requestJson: jsonString(preview.request),
  });

  try {
    const result = await executeRestoreJob(connectionId, input);
    updateDatabaseJob(restoreJobId, {
      status: 'completed',
      resultJson: jsonString(result),
      finishedAt: new Date().toISOString(),
    });
    recordAuditLog('database.restore', 'database_connection', connectionId, null, null);
    return { jobId: restoreJobId, sourceJobId: jobId, ...asObject(result) };
  } catch (err) {
    updateDatabaseJob(restoreJobId, {
      status: 'failed',
      error: errorMessage(err),
      finishedAt: new Date().toISOString(),
    });
    throw err;
  }
}

// ── Jobs ──────────────────────────────────────────────────────

export function listJobs(limit?: number) {
  return listJobOverviews(limit ?? 25);
}

export function getJob(id: string) {
  const job = getDatabaseJob(ensureJobId(id));
  if (!job) throw new HttpError(404, 'Database job not found.');
  const full = listJobOverviews(500).find((entry) => (entry as { id: string }).id === job.id);
  return full ?? job;
}

export function listOperationHistoryList(limit?: number) {
  return listOperationOverviews(limit ?? 25);
}

export async function getJobArtifactDownloadData(jobId: string) {
  return getJobArtifactDownload(jobId);
}
