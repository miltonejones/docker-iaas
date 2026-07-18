import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { bytes } from '../format';
import { AppIcon, PresetIcon } from '../icons';
import type {
  DatabaseConfirmationPreview,
  DatabaseConnectionDetail,
  DatabaseEngine,
  DatabaseJobOverview,
  DatabaseOperationOverview,
  DatabaseOverview,
} from '../types';

const DATABASE_MASTER_KEY_ERROR =
  'DOCKYARD_DATABASE_MASTER_KEY is required for saved database connections and database operations.';

type DatabaseTab =
  | 'connection'
  | 'schema'
  | 'read'
  | 'mutate'
  | 'migrate'
  | 'backup'
  | 'activity';

type MongoReadMode = 'find' | 'aggregate' | 'count';
type MongoMutationOperation =
  | 'insertOne'
  | 'insertMany'
  | 'updateOne'
  | 'updateMany'
  | 'deleteOne'
  | 'deleteMany';

interface ConnectionFormState {
  name: string;
  engine: DatabaseEngine;
  database: string;
  mysqlHost: string;
  mysqlPort: string;
  mysqlUsername: string;
  mysqlPassword: string;
  mysqlSsl: boolean;
  mongoMode: 'fields' | 'uri';
  mongoHost: string;
  mongoPort: string;
  mongoUsername: string;
  mongoPassword: string;
  mongoAuthDatabase: string;
  mongoDirectConnection: boolean;
  mongoTls: boolean;
  mongoUri: string;
}

interface MongoReadFormState {
  mode: MongoReadMode;
  database: string;
  collection: string;
  filter: string;
  projection: string;
  sort: string;
  limit: string;
  pipeline: string;
}

interface MongoMutationFormState {
  operation: MongoMutationOperation;
  database: string;
  collection: string;
  filter: string;
  update: string;
  document: string;
  documents: string;
  upsert: boolean;
}

interface PendingConfirmation {
  kind: 'mutate' | 'migrate' | 'backup' | 'restore';
  connectionId: string;
  payload: Record<string, unknown>;
  summary: string;
  request: unknown;
}

interface DatabasesPanelProps {
  activeId?: string;
}

function emptyConnectionForm(): ConnectionFormState {
  return {
    name: '',
    engine: 'mysql',
    database: '',
    mysqlHost: 'localhost',
    mysqlPort: '3306',
    mysqlUsername: '',
    mysqlPassword: '',
    mysqlSsl: false,
    mongoMode: 'fields',
    mongoHost: 'localhost',
    mongoPort: '27017',
    mongoUsername: '',
    mongoPassword: '',
    mongoAuthDatabase: '',
    mongoDirectConnection: false,
    mongoTls: false,
    mongoUri: '',
  };
}

function formFromConnection(connection: DatabaseConnectionDetail): ConnectionFormState {
  const summary = connection.summary;
  return {
    name: connection.name,
    engine: connection.engine,
    database: summary.database ?? '',
    mysqlHost: summary.host ?? 'localhost',
    mysqlPort: String(summary.port ?? 3306),
    mysqlUsername: summary.username ?? '',
    mysqlPassword: '',
    mysqlSsl: Boolean(summary.ssl),
    mongoMode: summary.mode ?? 'fields',
    mongoHost: summary.host ?? 'localhost',
    mongoPort: String(summary.port ?? 27017),
    mongoUsername: summary.username ?? '',
    mongoPassword: '',
    mongoAuthDatabase: summary.authDatabase ?? summary.database ?? '',
    mongoDirectConnection: Boolean(summary.directConnection),
    mongoTls: Boolean(summary.tls),
    mongoUri: '',
  };
}

function emptyMongoReadForm(database = ''): MongoReadFormState {
  return {
    mode: 'find',
    database,
    collection: '',
    filter: '{\n  \n}',
    projection: '{\n  \n}',
    sort: '{\n  \n}',
    limit: '25',
    pipeline: '[\n  {\n    "$match": {}\n  }\n]',
  };
}

function emptyMongoMutationForm(database = ''): MongoMutationFormState {
  return {
    operation: 'insertOne',
    database,
    collection: '',
    filter: '{\n  \n}',
    update: '{\n  "$set": {}\n}',
    document: '{\n  \n}',
    documents: '[\n  {\n    \n  }\n]',
    upsert: false,
  };
}

function isConfirmationPreview(value: unknown): value is DatabaseConfirmationPreview {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as DatabaseConfirmationPreview).requiresConfirmation === true &&
      typeof (value as DatabaseConfirmationPreview).summary === 'string',
  );
}

function formatDatabaseError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown database error.';
  if (message === DATABASE_MASTER_KEY_ERROR) {
    return `${message} Configure it on the server, then reload this page.`;
  }
  return message;
}

function renderScalar(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function toJsonText(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseOptionalJsonObject(text: string, label: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseRequiredJsonObject(text: string, label: string): Record<string, unknown> {
  const parsed = parseOptionalJsonObject(text, label);
  if (!parsed) throw new Error(`${label} is required.`);
  return parsed;
}

function parseRequiredJsonArray(text: string, label: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array.`);
  }
  return parsed;
}

function splitSqlStatements(input: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;

  for (const char of input) {
    current += char;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === ';') {
      const statement = current.slice(0, -1).trim();
      if (statement) statements.push(statement);
      current = '';
    }
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

function statusClass(status: string | null | undefined): string {
  if (status === 'completed' || status === 'ok' || status === 'running') return 'db-status-pill--ok';
  if (status === 'failed' || status === 'error') return 'db-status-pill--error';
  return 'db-status-pill--neutral';
}

function SectionNotice({
  tone,
  children,
}: {
  tone: 'warning' | 'error' | 'info' | 'success';
  children: ReactNode;
}) {
  return <div className={`db-notice db-notice--${tone}`}>{children}</div>;
}

function JsonBlock({ value, empty = 'No data yet.' }: { value: unknown; empty?: string }) {
  if (value === null || value === undefined || value === '') {
    return <p className="empty-sm">{empty}</p>;
  }
  return <pre className="db-json">{toJsonText(value)}</pre>;
}

function ResultTable({
  rows,
}: {
  rows: Array<Record<string, unknown>>;
}) {
  const columns = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set<string>()),
  );

  if (columns.length === 0) {
    return <p className="empty-sm">No rows returned.</p>;
  }

  return (
    <div className="table-wrap">
      <table className="table database-static-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column} className="mono">
                  {renderScalar(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OperationsTable({
  operations,
  emptyLabel,
}: {
  operations: DatabaseOperationOverview[];
  emptyLabel: string;
}) {
  if (operations.length === 0) {
    return <p className="empty-sm">{emptyLabel}</p>;
  }

  return (
    <div className="table-wrap">
      <table className="table database-static-table">
        <thead>
          <tr>
            <th>Category</th>
            <th>Summary</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {operations.map((operation) => (
            <tr key={operation.id}>
              <td>
                <span className="chip">{operation.category}</span>
              </td>
              <td>
                <div className="db-activity-cell">
                  <strong>{operation.summary}</strong>
                  <span className="muted mono">{operation.id}</span>
                  {(operation.request !== null && operation.request !== undefined) ||
                  (operation.result !== null && operation.result !== undefined) ||
                  operation.error ? (
                    <details className="db-inline-details">
                      <summary>Details</summary>
                      {operation.request !== null && operation.request !== undefined && (
                        <>
                          <div className="db-subhead">Request</div>
                          <JsonBlock value={operation.request} />
                        </>
                      )}
                      {operation.result !== null && operation.result !== undefined && (
                        <>
                          <div className="db-subhead">Result</div>
                          <JsonBlock value={operation.result} />
                        </>
                      )}
                      {operation.error && (
                        <>
                          <div className="db-subhead">Error</div>
                          <JsonBlock value={{ error: operation.error }} />
                        </>
                      )}
                    </details>
                  ) : null}
                </div>
              </td>
              <td>
                <span className={`db-status-pill ${statusClass(operation.status)}`}>{operation.status}</span>
              </td>
              <td className="muted">{new Date(operation.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JobsTable({
  jobs,
  emptyLabel,
}: {
  jobs: DatabaseJobOverview[];
  emptyLabel: string;
}) {
  if (jobs.length === 0) {
    return <p className="empty-sm">{emptyLabel}</p>;
  }

  return (
    <div className="table-wrap">
      <table className="table database-static-table">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Summary</th>
            <th>Status</th>
            <th>Artifact</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <span className="chip">{job.kind}</span>
              </td>
              <td>
                <div className="db-activity-cell">
                  <strong>{job.summary}</strong>
                  <span className="muted mono">{job.id}</span>
                  {(job.request !== null && job.request !== undefined) ||
                  (job.result !== null && job.result !== undefined) ||
                  job.error ? (
                    <details className="db-inline-details">
                      <summary>Details</summary>
                      {job.request !== null && job.request !== undefined && (
                        <>
                          <div className="db-subhead">Request</div>
                          <JsonBlock value={job.request} />
                        </>
                      )}
                      {job.result !== null && job.result !== undefined && (
                        <>
                          <div className="db-subhead">Result</div>
                          <JsonBlock value={job.result} />
                        </>
                      )}
                      {job.error && (
                        <>
                          <div className="db-subhead">Error</div>
                          <JsonBlock value={{ error: job.error }} />
                        </>
                      )}
                    </details>
                  ) : null}
                </div>
              </td>
              <td>
                <span className={`db-status-pill ${statusClass(job.status)}`}>{job.status}</span>
              </td>
              <td>
                {job.artifactAvailable ? (
                  <a className="btn btn--sm" href={api.databaseJobDownloadUrl(job.id)}>
                    Download {job.artifactSize ? `(${bytes(job.artifactSize)})` : ''}
                  </a>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td className="muted">{new Date(job.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SchemaView({ value }: { value: Record<string, unknown> | null }) {
  if (!value) return <p className="empty-sm">Run schema inspection to view tables or collections.</p>;

  if (value.engine === 'mysql') {
    const databases = Array.isArray(value.databases) ? (value.databases as Array<Record<string, unknown>>) : [];
    const tables = Array.isArray(value.tables) ? (value.tables as Array<Record<string, unknown>>) : [];
    return (
      <div className="db-stack">
        <div className="db-inline-metadata">
          <span className="chip">Database: {renderScalar(value.selectedDatabase)}</span>
          <span className="chip">Schemas: {databases.length}</span>
          <span className="chip">Tables: {tables.length}</span>
        </div>
        <div className="table-wrap">
          <table className="table database-static-table">
            <thead>
              <tr>
                <th>Table</th>
                <th>Type</th>
                <th>Engine</th>
                <th>Rows</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((table) => (
                <tr key={String(table.name)}>
                  <td className="mono">{renderScalar(table.name)}</td>
                  <td>{renderScalar(table.type)}</td>
                  <td>{renderScalar(table.engine)}</td>
                  <td className="mono">{renderScalar(table.rowCountEstimate)}</td>
                  <td>
                    <details className="db-inline-details">
                      <summary>Columns / indexes</summary>
                      <div className="db-subhead">Columns</div>
                      <JsonBlock value={table.columns} empty="No column metadata." />
                      <div className="db-subhead">Indexes</div>
                      <JsonBlock value={table.indexes} empty="No index metadata." />
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const collections = Array.isArray(value.collections)
    ? (value.collections as Array<Record<string, unknown>>)
    : [];

  return (
    <div className="db-stack">
      <div className="db-inline-metadata">
        <span className="chip">Database: {renderScalar(value.selectedDatabase)}</span>
        <span className="chip">Collections: {collections.length}</span>
      </div>
      <div className="table-wrap">
        <table className="table database-static-table">
          <thead>
            <tr>
              <th>Collection</th>
              <th>Type</th>
              <th>Estimated docs</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {collections.map((collection) => (
              <tr key={String(collection.name)}>
                <td className="mono">{renderScalar(collection.name)}</td>
                <td>{renderScalar(collection.type)}</td>
                <td className="mono">{renderScalar(collection.estimatedDocumentCount)}</td>
                <td>
                  <details className="db-inline-details">
                    <summary>Fields / indexes</summary>
                    <div className="db-subhead">Sampled fields</div>
                    <JsonBlock value={collection.sampledFields} empty="No sampled fields." />
                    <div className="db-subhead">Indexes</div>
                    <JsonBlock value={collection.indexes} empty="No indexes." />
                    <div className="db-subhead">Options</div>
                    <JsonBlock value={collection.options} empty="No collection options." />
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DatabasesPanel({ activeId }: DatabasesPanelProps) {
  const navigate = useNavigate();
  const isCreating = activeId === 'new';
  const [overview, setOverview] = useState<DatabaseOverview | null>(null);
  const [connections, setConnections] = useState<DatabaseConnectionDetail[]>([]);
  const [operations, setOperations] = useState<DatabaseOperationOverview[]>([]);
  const [jobs, setJobs] = useState<DatabaseJobOverview[]>([]);
  const [pageError, setPageError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<DatabaseTab>('connection');
  const [connectionForm, setConnectionForm] = useState<ConnectionFormState>(emptyConnectionForm);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionSuccess, setConnectionSuccess] = useState<string | null>(null);
  const [savingConnection, setSavingConnection] = useState(false);
  const [deletingConnection, setDeletingConnection] = useState(false);

  const [testingConnection, setTestingConnection] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);

  const [schemaDatabase, setSchemaDatabase] = useState('');
  const [schemaBusy, setSchemaBusy] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaResult, setSchemaResult] = useState<Record<string, unknown> | null>(null);

  const [mysqlReadSql, setMysqlReadSql] = useState('SELECT 1 AS ok');
  const [mongoReadForm, setMongoReadForm] = useState<MongoReadFormState>(emptyMongoReadForm());
  const [readBusy, setReadBusy] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [readResult, setReadResult] = useState<Record<string, unknown> | null>(null);

  const [mysqlMutationSql, setMysqlMutationSql] = useState('');
  const [mongoMutationForm, setMongoMutationForm] = useState<MongoMutationFormState>(emptyMongoMutationForm());
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationResult, setMutationResult] = useState<Record<string, unknown> | null>(null);

  const [mysqlMigrationSql, setMysqlMigrationSql] = useState('');
  const [mongoMigrationJson, setMongoMigrationJson] = useState('[\n  {\n    "operation": "createCollection",\n    "collection": "example"\n  }\n]');
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [migrationResult, setMigrationResult] = useState<Record<string, unknown> | null>(null);

  const [backupDatabase, setBackupDatabase] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupResult, setBackupResult] = useState<Record<string, unknown> | null>(null);

  const [restoreJobId, setRestoreJobId] = useState('');
  const [restoreTargetDatabase, setRestoreTargetDatabase] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<Record<string, unknown> | null>(null);

  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [confirming, setConfirming] = useState(false);

  const selectedConnection = useMemo(
    () => (activeId && activeId !== 'new' ? connections.find((connection) => connection.id === activeId) ?? null : null),
    [activeId, connections],
  );
  const connectionOperations = selectedConnection
    ? operations.filter((operation) => operation.connectionId === selectedConnection.id)
    : [];
  const connectionJobs = selectedConnection ? jobs.filter((job) => job.connectionId === selectedConnection.id) : [];
  const backupJobs = useMemo(
    () => jobs.filter((job) => job.kind === 'backup' && job.artifactAvailable),
    [jobs],
  );
  const masterKeyMissing = overview ? !overview.masterKeyConfigured : false;

  const loadConsole = useCallback(async () => {
    try {
      setPageError(null);
      const [overviewData, connectionData, operationData, jobData] = await Promise.all([
        api.databaseOverview(),
        api.databaseConnections(),
        api.databaseOperations(25),
        api.databaseJobs(25),
      ]);
      setOverview(overviewData);
      setConnections(connectionData);
      setOperations(operationData);
      setJobs(jobData);
    } catch (error) {
      setPageError(formatDatabaseError(error));
    }
  }, []);

  useEffect(() => {
    loadConsole();
  }, [loadConsole]);

  useEffect(() => {
    if (selectedConnection) {
      setConnectionForm(formFromConnection(selectedConnection));
      setSchemaDatabase(selectedConnection.summary.database);
      setMongoReadForm(emptyMongoReadForm(selectedConnection.summary.database));
      setMongoMutationForm(emptyMongoMutationForm(selectedConnection.summary.database));
      setRestoreTargetDatabase(selectedConnection.summary.database);
      setActiveTab('connection');
    } else if (isCreating) {
      setConnectionForm(emptyConnectionForm());
      setSchemaDatabase('');
      setMongoReadForm(emptyMongoReadForm());
      setMongoMutationForm(emptyMongoMutationForm());
      setRestoreTargetDatabase('');
      setActiveTab('connection');
    }
    setConnectionError(null);
    setConnectionSuccess(null);
    setTestError(null);
    setTestResult(null);
    setSchemaError(null);
    setSchemaResult(null);
    setReadError(null);
    setReadResult(null);
    setMutationError(null);
    setMutationResult(null);
    setMigrationError(null);
    setMigrationResult(null);
    setBackupError(null);
    setBackupResult(null);
    setRestoreError(null);
    setRestoreResult(null);
    setPendingConfirmation(null);
  }, [isCreating, selectedConnection]);

  useEffect(() => {
    if (!restoreJobId && backupJobs.length > 0) {
      setRestoreJobId(backupJobs[0].id);
    }
  }, [backupJobs, restoreJobId]);

  async function refreshAfterMutation() {
    await loadConsole();
  }

  function updateForm<K extends keyof ConnectionFormState>(key: K, value: ConnectionFormState[K]) {
    setConnectionForm((current) => ({ ...current, [key]: value }));
  }

  function updateMongoRead<K extends keyof MongoReadFormState>(key: K, value: MongoReadFormState[K]) {
    setMongoReadForm((current) => ({ ...current, [key]: value }));
  }

  function updateMongoMutation<K extends keyof MongoMutationFormState>(key: K, value: MongoMutationFormState[K]) {
    setMongoMutationForm((current) => ({ ...current, [key]: value }));
  }

  function buildConnectionPayload(isUpdate: boolean): {
    name: string;
    engine: DatabaseEngine;
    config: Record<string, unknown>;
  } {
    const base = {
      name: connectionForm.name.trim(),
      engine: connectionForm.engine,
    };
    if (connectionForm.engine === 'mysql') {
      const config: Record<string, unknown> = {
        host: connectionForm.mysqlHost.trim(),
        port: Number(connectionForm.mysqlPort || 3306),
        database: connectionForm.database.trim(),
        username: connectionForm.mysqlUsername.trim(),
        ssl: connectionForm.mysqlSsl,
      };
      if (!isUpdate || connectionForm.mysqlPassword !== '') {
        config.password = connectionForm.mysqlPassword;
      }
      return { ...base, config };
    }

    if (connectionForm.mongoMode === 'uri') {
      const config: Record<string, unknown> = {
        mode: 'uri',
        database: connectionForm.database.trim(),
      };
      if (!isUpdate || connectionForm.mongoUri.trim()) {
        config.uri = connectionForm.mongoUri.trim();
      }
      return { ...base, config };
    }

    const config: Record<string, unknown> = {
      mode: 'fields',
      host: connectionForm.mongoHost.trim(),
      port: Number(connectionForm.mongoPort || 27017),
      database: connectionForm.database.trim(),
      username: connectionForm.mongoUsername.trim(),
      authDatabase: (connectionForm.mongoAuthDatabase || connectionForm.database).trim(),
      directConnection: connectionForm.mongoDirectConnection,
      tls: connectionForm.mongoTls,
    };
    if (!isUpdate || connectionForm.mongoPassword !== '') {
      config.password = connectionForm.mongoPassword;
    }
    return { ...base, config };
  }

  async function saveConnection() {
    setSavingConnection(true);
    setConnectionError(null);
    setConnectionSuccess(null);
    try {
      const payload = buildConnectionPayload(!isCreating);
      const saved = isCreating
        ? await api.databaseCreateConnection(payload)
        : await api.databaseUpdateConnection(selectedConnection!.id, payload);
      await refreshAfterMutation();
      setConnectionSuccess(isCreating ? 'Connection saved.' : 'Connection updated.');
      navigate(`/databases/${saved.id}`, { replace: true });
    } catch (error) {
      setConnectionError(formatDatabaseError(error));
    } finally {
      setSavingConnection(false);
    }
  }

  async function deleteConnection() {
    if (!selectedConnection) return;
    if (!confirm(`Delete saved connection "${selectedConnection.name}"?`)) return;
    setDeletingConnection(true);
    setConnectionError(null);
    try {
      await api.databaseDeleteConnection(selectedConnection.id);
      await refreshAfterMutation();
      navigate('/databases');
    } catch (error) {
      setConnectionError(formatDatabaseError(error));
    } finally {
      setDeletingConnection(false);
    }
  }

  async function runConnectionTest() {
    if (!selectedConnection) return;
    setTestingConnection(true);
    setTestError(null);
    try {
      setTestResult(await api.databaseTestConnection(selectedConnection.id));
      await refreshAfterMutation();
    } catch (error) {
      setTestError(formatDatabaseError(error));
      setTestResult(null);
      await refreshAfterMutation();
    } finally {
      setTestingConnection(false);
    }
  }

  async function inspectSchema() {
    if (!selectedConnection) return;
    setSchemaBusy(true);
    setSchemaError(null);
    try {
      setSchemaResult(
        await api.databaseSchema(selectedConnection.id, schemaDatabase.trim() || undefined),
      );
    } catch (error) {
      setSchemaError(formatDatabaseError(error));
      setSchemaResult(null);
    } finally {
      setSchemaBusy(false);
    }
  }

  function buildReadPayload(): Record<string, unknown> {
    if (!selectedConnection) throw new Error('Select a connection first.');
    if (selectedConnection.engine === 'mysql') {
      return { sql: mysqlReadSql.trim() };
    }

    const payload: Record<string, unknown> = {
      mode: mongoReadForm.mode,
      collection: mongoReadForm.collection.trim(),
    };
    if (mongoReadForm.database.trim()) payload.database = mongoReadForm.database.trim();
    if (mongoReadForm.mode === 'count') {
      const filter = parseOptionalJsonObject(mongoReadForm.filter, 'Filter');
      if (filter) payload.filter = filter;
      return payload;
    }
    if (mongoReadForm.mode === 'aggregate') {
      payload.pipeline = parseRequiredJsonArray(mongoReadForm.pipeline, 'Pipeline');
      if (mongoReadForm.limit.trim()) payload.limit = Number(mongoReadForm.limit);
      return payload;
    }
    const filter = parseOptionalJsonObject(mongoReadForm.filter, 'Filter');
    const projection = parseOptionalJsonObject(mongoReadForm.projection, 'Projection');
    const sort = parseOptionalJsonObject(mongoReadForm.sort, 'Sort');
    if (filter) payload.filter = filter;
    if (projection) payload.projection = projection;
    if (sort) payload.sort = sort;
    if (mongoReadForm.limit.trim()) payload.limit = Number(mongoReadForm.limit);
    return payload;
  }

  async function runReadQuery() {
    if (!selectedConnection) return;
    setReadBusy(true);
    setReadError(null);
    try {
      setReadResult(await api.databaseRead(selectedConnection.id, buildReadPayload()));
    } catch (error) {
      setReadError(formatDatabaseError(error));
      setReadResult(null);
    } finally {
      setReadBusy(false);
    }
  }

  function buildMutationPayload(): Record<string, unknown> {
    if (!selectedConnection) throw new Error('Select a connection first.');
    if (selectedConnection.engine === 'mysql') {
      return { statement: mysqlMutationSql.trim() };
    }

    const payload: Record<string, unknown> = {
      operation: mongoMutationForm.operation,
      collection: mongoMutationForm.collection.trim(),
    };
    if (mongoMutationForm.database.trim()) payload.database = mongoMutationForm.database.trim();

    switch (mongoMutationForm.operation) {
      case 'insertOne':
        payload.document = parseRequiredJsonObject(mongoMutationForm.document, 'Document');
        break;
      case 'insertMany':
        payload.documents = parseRequiredJsonArray(mongoMutationForm.documents, 'Documents');
        break;
      case 'updateOne':
      case 'updateMany':
        payload.filter = parseOptionalJsonObject(mongoMutationForm.filter, 'Filter') ?? {};
        payload.update = parseRequiredJsonObject(mongoMutationForm.update, 'Update');
        payload.upsert = mongoMutationForm.upsert;
        break;
      case 'deleteOne':
      case 'deleteMany':
        payload.filter = parseOptionalJsonObject(mongoMutationForm.filter, 'Filter') ?? {};
        break;
    }
    return payload;
  }

  function buildMigrationPayload(): Record<string, unknown> {
    if (!selectedConnection) throw new Error('Select a connection first.');
    if (selectedConnection.engine === 'mysql') {
      return { statements: splitSqlStatements(mysqlMigrationSql) };
    }
    return { steps: parseRequiredJsonArray(mongoMigrationJson, 'Migration steps') };
  }

  async function previewAction(kind: PendingConfirmation['kind']) {
    if (!selectedConnection) return;
    const execute = {
      mutate: async () => api.databaseMutate(selectedConnection.id, buildMutationPayload()),
      migrate: async () => api.databaseMigrate(selectedConnection.id, buildMigrationPayload()),
      backup: async () =>
        api.databaseBackup(selectedConnection.id, {
          ...(backupDatabase.trim() ? { database: backupDatabase.trim() } : {}),
        }),
      restore: async () =>
        api.databaseRestore(selectedConnection.id, {
          jobId: restoreJobId.trim(),
          ...(restoreTargetDatabase.trim() ? { targetDatabase: restoreTargetDatabase.trim() } : {}),
        }),
    }[kind];

    try {
      if (kind === 'mutate') {
        setMutationBusy(true);
        setMutationError(null);
      } else if (kind === 'migrate') {
        setMigrationBusy(true);
        setMigrationError(null);
      } else if (kind === 'backup') {
        setBackupBusy(true);
        setBackupError(null);
      } else {
        setRestoreBusy(true);
        setRestoreError(null);
      }

      const response = await execute();
      if (!isConfirmationPreview(response)) {
        throw new Error('Expected preview confirmation response from the server.');
      }
      const payload =
        kind === 'mutate'
          ? buildMutationPayload()
          : kind === 'migrate'
            ? buildMigrationPayload()
            : kind === 'backup'
              ? { ...(backupDatabase.trim() ? { database: backupDatabase.trim() } : {}) }
              : {
                  jobId: restoreJobId.trim(),
                  ...(restoreTargetDatabase.trim()
                    ? { targetDatabase: restoreTargetDatabase.trim() }
                    : {}),
                };
      setPendingConfirmation({
        kind,
        connectionId: selectedConnection.id,
        payload,
        summary: response.summary,
        request: response.request,
      });
    } catch (error) {
      const message = formatDatabaseError(error);
      if (kind === 'mutate') setMutationError(message);
      if (kind === 'migrate') setMigrationError(message);
      if (kind === 'backup') setBackupError(message);
      if (kind === 'restore') setRestoreError(message);
    } finally {
      setMutationBusy(false);
      setMigrationBusy(false);
      setBackupBusy(false);
      setRestoreBusy(false);
    }
  }

  async function confirmPending() {
    if (!pendingConfirmation) return;
    setConfirming(true);
    try {
      const request = { ...pendingConfirmation.payload, confirmed: true };
      let result: Record<string, unknown>;
      if (pendingConfirmation.kind === 'mutate') {
        result = (await api.databaseMutate(
          pendingConfirmation.connectionId,
          request,
        )) as Record<string, unknown>;
        setMutationResult(result);
      } else if (pendingConfirmation.kind === 'migrate') {
        result = (await api.databaseMigrate(
          pendingConfirmation.connectionId,
          request,
        )) as Record<string, unknown>;
        setMigrationResult(result);
      } else if (pendingConfirmation.kind === 'backup') {
        result = (await api.databaseBackup(
          pendingConfirmation.connectionId,
          request,
        )) as Record<string, unknown>;
        setBackupResult(result);
      } else {
        result = (await api.databaseRestore(
          pendingConfirmation.connectionId,
          request,
        )) as Record<string, unknown>;
        setRestoreResult(result);
      }
      await refreshAfterMutation();
      setPendingConfirmation(null);
    } catch (error) {
      const message = formatDatabaseError(error);
      if (pendingConfirmation.kind === 'mutate') setMutationError(message);
      if (pendingConfirmation.kind === 'migrate') setMigrationError(message);
      if (pendingConfirmation.kind === 'backup') setBackupError(message);
      if (pendingConfirmation.kind === 'restore') setRestoreError(message);
    } finally {
      setConfirming(false);
    }
  }

  const summaryCards = overview
    ? [
        { label: 'Saved connections', value: overview.connections.total },
        { label: 'MySQL', value: overview.connections.byEngine.mysql },
        { label: 'MongoDB', value: overview.connections.byEngine.mongodb },
        { label: 'Needs attention', value: overview.connections.unhealthy },
      ]
    : [];

  return (
    <div className="db-stack">
      {pageError && <SectionNotice tone="error">{pageError}</SectionNotice>}
      {masterKeyMissing && (
        <SectionNotice tone="warning">
          {DATABASE_MASTER_KEY_ERROR} Read-only metadata still loads, but save/test/query actions are disabled until the server is configured.
        </SectionNotice>
      )}

      {!activeId && (
      <section className="panel">
        <div className="panel__head">
          <h2>
            Databases <span className="count">{connections.length}</span>
          </h2>
          {overview && (
            <span className="muted">
              Read queries are capped at {overview.limits.maxReadRows} rows and {overview.limits.maxQueryTimeMs}ms.
            </span>
          )}
        </div>

        {summaryCards.length > 0 && (
          <div className="db-overview-grid">
            {summaryCards.map((card) => (
              <div key={card.label} className="db-overview-card">
                <strong>{card.value}</strong>
                <span>{card.label}</span>
              </div>
            ))}
          </div>
        )}

        <div className="db-activity-grid">
          <div className="db-activity-panel">
            <div className="db-activity-panel__head">
              <h3>Recent operations</h3>
              <span className="muted">{operations.length} loaded</span>
            </div>
            <OperationsTable operations={operations} emptyLabel="No database operations yet." />
          </div>
          <div className="db-activity-panel">
            <div className="db-activity-panel__head">
              <h3>Recent jobs</h3>
              <span className="muted">{jobs.length} loaded</span>
            </div>
            <JobsTable jobs={jobs} emptyLabel="No backup or restore jobs yet." />
          </div>
        </div>
      </section>
      )}

      {!activeId && (
      <section className="panel">
        <div className="panel__head">
          <h2>Connections <span className="count">{connections.length}</span></h2>
          <button className="btn btn--primary btn--sm" onClick={() => navigate('/databases/new')}>
            <AppIcon name="plus" /> New connection
          </button>
        </div>
        {connections.length === 0 ? (
          <p className="empty">No saved database connections yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Engine</th>
                  <th>Database</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((connection) => (
                  <tr key={connection.id} onClick={() => navigate(`/databases/${connection.id}`)}>
                    <td>
                      <PresetIcon id={connection.engine === 'mysql' ? 'mysql' : 'mongo'} /> {connection.name}
                    </td>
                    <td><span className="chip">{connection.engine}</span></td>
                    <td className="mono muted">{connection.summary.database}</td>
                    <td>
                      <span
                        className={`db-status-pill ${statusClass(connection.lastTestStatus)}`}
                        title={connection.lastTestError ?? undefined}
                      >
                        {connection.lastTestStatus ?? 'new'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}

      {activeId && (
      <section className="panel">
        <div className="panel__head">
          <button className="btn btn--ghost btn--sm" onClick={() => navigate('/databases')}>
            ← Connections
          </button>
        </div>
        <div className="panel-layout panel-layout--full">
          <div className="panel-main">
            {!selectedConnection && !isCreating && (
              <div className="db-empty-state">
                <AppIcon name="database" className="db-empty-state__icon" />
                <h3>Select a connection</h3>
                <p className="muted">
                  Choose a saved MySQL or MongoDB connection from the left, or create a new one.
                </p>
              </div>
            )}

            {(selectedConnection || isCreating) && (
              <>
                <div className="db-connection-head">
                  <div>
                    <h3>{isCreating ? 'New saved connection' : selectedConnection?.name}</h3>
                    {!isCreating && selectedConnection && (
                      <p className="muted">
                        {selectedConnection.engine.toUpperCase()} · updated{' '}
                        {new Date(selectedConnection.updatedAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <div className="db-connection-head__actions">
                    {!isCreating && (
                      <>
                        <button
                          className="btn btn--sm"
                          onClick={runConnectionTest}
                          disabled={testingConnection || masterKeyMissing}
                        >
                          {testingConnection ? 'Testing…' : 'Test connection'}
                        </button>
                        <button
                          className="btn btn--sm btn--danger"
                          onClick={deleteConnection}
                          disabled={deletingConnection}
                        >
                          {deletingConnection ? 'Deleting…' : 'Delete'}
                        </button>
                      </>
                    )}
                    <button
                      className="btn btn--primary btn--sm"
                      onClick={saveConnection}
                      disabled={savingConnection || masterKeyMissing}
                    >
                      {savingConnection ? 'Saving…' : isCreating ? 'Save connection' : 'Save changes'}
                    </button>
                  </div>
                </div>

                <div className="db-tabs">
                  {(
                    [
                      ['connection', 'Connection'],
                      ['schema', 'Schema'],
                      ['read', 'Read'],
                      ['mutate', 'Mutate'],
                      ['migrate', 'Migrate'],
                      ['backup', 'Backup / Restore'],
                      ['activity', 'Activity'],
                    ] as Array<[DatabaseTab, string]>
                  ).map(([tab, label]) => (
                    <button
                      key={tab}
                      className={`db-tab${activeTab === tab ? ' db-tab--active' : ''}`}
                      onClick={() => setActiveTab(tab)}
                      disabled={tab !== 'connection' && isCreating}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {connectionError && <SectionNotice tone="error">{connectionError}</SectionNotice>}
                {connectionSuccess && <SectionNotice tone="success">{connectionSuccess}</SectionNotice>}

                {activeTab === 'connection' && (
                  <div className="db-stack">
                    <div className="db-form-grid">
                      <label className="field">
                        <span>Connection name</span>
                        <input
                          value={connectionForm.name}
                          onChange={(event) => updateForm('name', event.target.value)}
                          placeholder="Primary MySQL"
                        />
                      </label>
                      <label className="field">
                        <span>Engine</span>
                        <select
                          value={connectionForm.engine}
                          onChange={(event) =>
                            updateForm('engine', event.target.value as DatabaseEngine)
                          }
                        >
                          <option value="mysql">MySQL</option>
                          <option value="mongodb">MongoDB</option>
                        </select>
                      </label>
                    </div>

                    <label className="field">
                      <span>Default database</span>
                      <input
                        value={connectionForm.database}
                        onChange={(event) => updateForm('database', event.target.value)}
                        placeholder={connectionForm.engine === 'mysql' ? 'app_db' : 'appdb'}
                      />
                    </label>

                    {connectionForm.engine === 'mysql' ? (
                      <>
                        <div className="db-form-grid">
                          <label className="field">
                            <span>Host</span>
                            <input
                              value={connectionForm.mysqlHost}
                              onChange={(event) => updateForm('mysqlHost', event.target.value)}
                              placeholder="localhost"
                            />
                          </label>
                          <label className="field">
                            <span>Port</span>
                            <input
                              value={connectionForm.mysqlPort}
                              onChange={(event) => updateForm('mysqlPort', event.target.value)}
                              inputMode="numeric"
                            />
                          </label>
                        </div>
                        <div className="db-form-grid">
                          <label className="field">
                            <span>Username</span>
                            <input
                              value={connectionForm.mysqlUsername}
                              onChange={(event) => updateForm('mysqlUsername', event.target.value)}
                              placeholder="root"
                            />
                          </label>
                          <label className="field">
                            <span>{isCreating ? 'Password' : 'Password (leave blank to keep current)'}</span>
                            <input
                              type="password"
                              autoComplete="new-password"
                              value={connectionForm.mysqlPassword}
                              onChange={(event) => updateForm('mysqlPassword', event.target.value)}
                              placeholder={selectedConnection?.summary.hasPassword ? 'Stored password preserved' : ''}
                            />
                          </label>
                        </div>
                        <label className="db-checkbox">
                          <input
                            type="checkbox"
                            checked={connectionForm.mysqlSsl}
                            onChange={(event) => updateForm('mysqlSsl', event.target.checked)}
                          />
                          <span>Enable SSL</span>
                        </label>
                      </>
                    ) : (
                      <>
                        <label className="field">
                          <span>Connection mode</span>
                          <select
                            value={connectionForm.mongoMode}
                            onChange={(event) =>
                              updateForm('mongoMode', event.target.value as 'fields' | 'uri')
                            }
                          >
                            <option value="fields">Host / port fields</option>
                            <option value="uri">MongoDB URI</option>
                          </select>
                        </label>

                        {connectionForm.mongoMode === 'fields' ? (
                          <>
                            <div className="db-form-grid">
                              <label className="field">
                                <span>Host</span>
                                <input
                                  value={connectionForm.mongoHost}
                                  onChange={(event) => updateForm('mongoHost', event.target.value)}
                                  placeholder="localhost"
                                />
                              </label>
                              <label className="field">
                                <span>Port</span>
                                <input
                                  value={connectionForm.mongoPort}
                                  onChange={(event) => updateForm('mongoPort', event.target.value)}
                                  inputMode="numeric"
                                />
                              </label>
                            </div>
                            <div className="db-form-grid">
                              <label className="field">
                                <span>Username</span>
                                <input
                                  value={connectionForm.mongoUsername}
                                  onChange={(event) =>
                                    updateForm('mongoUsername', event.target.value)
                                  }
                                  placeholder="optional"
                                />
                              </label>
                              <label className="field">
                                <span>{isCreating ? 'Password' : 'Password (leave blank to keep current)'}</span>
                                <input
                                  type="password"
                                  autoComplete="new-password"
                                  value={connectionForm.mongoPassword}
                                  onChange={(event) =>
                                    updateForm('mongoPassword', event.target.value)
                                  }
                                  placeholder={selectedConnection?.summary.hasPassword ? 'Stored password preserved' : ''}
                                />
                              </label>
                            </div>
                            <label className="field">
                              <span>Auth database</span>
                              <input
                                value={connectionForm.mongoAuthDatabase}
                                onChange={(event) =>
                                  updateForm('mongoAuthDatabase', event.target.value)
                                }
                                placeholder="admin"
                              />
                            </label>
                            <div className="db-checkbox-row">
                              <label className="db-checkbox">
                                <input
                                  type="checkbox"
                                  checked={connectionForm.mongoDirectConnection}
                                  onChange={(event) =>
                                    updateForm('mongoDirectConnection', event.target.checked)
                                  }
                                />
                                <span>Direct connection</span>
                              </label>
                              <label className="db-checkbox">
                                <input
                                  type="checkbox"
                                  checked={connectionForm.mongoTls}
                                  onChange={(event) =>
                                    updateForm('mongoTls', event.target.checked)
                                  }
                                />
                                <span>Enable TLS</span>
                              </label>
                            </div>
                          </>
                        ) : (
                          <label className="field">
                            <span>{isCreating ? 'MongoDB URI' : 'MongoDB URI (leave blank to keep current)'}</span>
                            <textarea
                              rows={4}
                              value={connectionForm.mongoUri}
                              onChange={(event) => updateForm('mongoUri', event.target.value)}
                              placeholder={
                                selectedConnection?.summary.uriRedacted ?? 'mongodb://user:pass@host:27017/appdb'
                              }
                            />
                            {selectedConnection?.summary.uriRedacted && (
                              <span className="hint">Current saved URI: {selectedConnection.summary.uriRedacted}</span>
                            )}
                          </label>
                        )}
                      </>
                    )}

                    {!isCreating && selectedConnection && (
                      <div className="db-key-value">
                        <div>
                          <span className="muted">Created</span>
                          <strong>{new Date(selectedConnection.createdAt).toLocaleString()}</strong>
                        </div>
                        <div>
                          <span className="muted">Last test</span>
                          <strong>
                            {selectedConnection.lastTestedAt
                              ? new Date(selectedConnection.lastTestedAt).toLocaleString()
                              : 'Not tested'}
                          </strong>
                        </div>
                        <div>
                          <span className="muted">Saved secret</span>
                          <strong>{selectedConnection.summary.hasPassword ? 'Yes' : 'No'}</strong>
                        </div>
                      </div>
                    )}

                    {testError && <SectionNotice tone="error">{testError}</SectionNotice>}
                    {testResult && (
                      <div>
                        <div className="db-subhead">Latest test result</div>
                        <JsonBlock value={testResult} />
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'schema' && selectedConnection && (
                  <div className="db-stack">
                    <div className="db-toolbar">
                      <label className="field db-toolbar__field">
                        <span>Database override</span>
                        <input
                          value={schemaDatabase}
                          onChange={(event) => setSchemaDatabase(event.target.value)}
                          placeholder={selectedConnection.summary.database}
                        />
                      </label>
                      <button
                        className="btn btn--sm"
                        onClick={inspectSchema}
                        disabled={schemaBusy || masterKeyMissing}
                      >
                        {schemaBusy ? 'Inspecting…' : 'Inspect schema'}
                      </button>
                    </div>
                    {schemaError && <SectionNotice tone="error">{schemaError}</SectionNotice>}
                    <SchemaView value={schemaResult} />
                  </div>
                )}

                {activeTab === 'read' && selectedConnection && (
                  <div className="db-stack">
                    {selectedConnection.engine === 'mysql' ? (
                      <>
                        <label className="field">
                          <span>Read-only SQL</span>
                          <textarea
                            rows={8}
                            value={mysqlReadSql}
                            onChange={(event) => setMysqlReadSql(event.target.value)}
                            placeholder="SELECT * FROM users ORDER BY id DESC"
                          />
                          <span className="hint">Only SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, and WITH are allowed.</span>
                        </label>
                      </>
                    ) : (
                      <>
                        <div className="db-form-grid">
                          <label className="field">
                            <span>Mode</span>
                            <select
                              value={mongoReadForm.mode}
                              onChange={(event) =>
                                updateMongoRead('mode', event.target.value as MongoReadMode)
                              }
                            >
                              <option value="find">find</option>
                              <option value="aggregate">aggregate</option>
                              <option value="count">count</option>
                            </select>
                          </label>
                          <label className="field">
                            <span>Database</span>
                            <input
                              value={mongoReadForm.database}
                              onChange={(event) => updateMongoRead('database', event.target.value)}
                              placeholder={selectedConnection.summary.database}
                            />
                          </label>
                          <label className="field">
                            <span>Collection</span>
                            <input
                              value={mongoReadForm.collection}
                              onChange={(event) =>
                                updateMongoRead('collection', event.target.value)
                              }
                              placeholder="users"
                            />
                          </label>
                          {mongoReadForm.mode !== 'count' && (
                            <label className="field">
                              <span>Limit</span>
                              <input
                                value={mongoReadForm.limit}
                                onChange={(event) => updateMongoRead('limit', event.target.value)}
                                inputMode="numeric"
                              />
                            </label>
                          )}
                        </div>

                        {mongoReadForm.mode === 'aggregate' ? (
                          <label className="field">
                            <span>Pipeline JSON array</span>
                            <textarea
                              rows={10}
                              value={mongoReadForm.pipeline}
                              onChange={(event) => updateMongoRead('pipeline', event.target.value)}
                            />
                          </label>
                        ) : (
                          <>
                            <label className="field">
                              <span>Filter JSON</span>
                              <textarea
                                rows={6}
                                value={mongoReadForm.filter}
                                onChange={(event) => updateMongoRead('filter', event.target.value)}
                              />
                            </label>
                            {mongoReadForm.mode === 'find' && (
                              <div className="db-form-grid">
                                <label className="field">
                                  <span>Projection JSON</span>
                                  <textarea
                                    rows={5}
                                    value={mongoReadForm.projection}
                                    onChange={(event) =>
                                      updateMongoRead('projection', event.target.value)
                                    }
                                  />
                                </label>
                                <label className="field">
                                  <span>Sort JSON</span>
                                  <textarea
                                    rows={5}
                                    value={mongoReadForm.sort}
                                    onChange={(event) =>
                                      updateMongoRead('sort', event.target.value)
                                    }
                                  />
                                </label>
                              </div>
                            )}
                          </>
                        )}
                      </>
                    )}

                    <div className="db-toolbar">
                      <button
                        className="btn btn--primary btn--sm"
                        onClick={runReadQuery}
                        disabled={readBusy || masterKeyMissing}
                      >
                        {readBusy ? 'Running…' : 'Run read query'}
                      </button>
                    </div>

                    {readError && <SectionNotice tone="error">{readError}</SectionNotice>}
                    {readResult && Array.isArray(readResult.rows) && (
                      <ResultTable
                        rows={(readResult.rows as Array<Record<string, unknown>>).filter(
                          (row): row is Record<string, unknown> =>
                            Boolean(row) && typeof row === 'object' && !Array.isArray(row),
                        )}
                      />
                    )}
                    {readResult && (
                      <>
                        <div className="db-subhead">Response</div>
                        <JsonBlock value={readResult} />
                      </>
                    )}
                  </div>
                )}

                {activeTab === 'mutate' && selectedConnection && (
                  <div className="db-stack">
                    {selectedConnection.engine === 'mysql' ? (
                      <label className="field">
                        <span>Single SQL mutation statement</span>
                        <textarea
                          rows={7}
                          value={mysqlMutationSql}
                          onChange={(event) => setMysqlMutationSql(event.target.value)}
                          placeholder="UPDATE users SET active = 0 WHERE last_login < NOW() - INTERVAL 90 DAY"
                        />
                        <span className="hint">Only INSERT, UPDATE, DELETE, and REPLACE are accepted.</span>
                      </label>
                    ) : (
                      <>
                        <div className="db-form-grid">
                          <label className="field">
                            <span>Operation</span>
                            <select
                              value={mongoMutationForm.operation}
                              onChange={(event) =>
                                updateMongoMutation(
                                  'operation',
                                  event.target.value as MongoMutationOperation,
                                )
                              }
                            >
                              <option value="insertOne">insertOne</option>
                              <option value="insertMany">insertMany</option>
                              <option value="updateOne">updateOne</option>
                              <option value="updateMany">updateMany</option>
                              <option value="deleteOne">deleteOne</option>
                              <option value="deleteMany">deleteMany</option>
                            </select>
                          </label>
                          <label className="field">
                            <span>Database</span>
                            <input
                              value={mongoMutationForm.database}
                              onChange={(event) =>
                                updateMongoMutation('database', event.target.value)
                              }
                              placeholder={selectedConnection.summary.database}
                            />
                          </label>
                          <label className="field">
                            <span>Collection</span>
                            <input
                              value={mongoMutationForm.collection}
                              onChange={(event) =>
                                updateMongoMutation('collection', event.target.value)
                              }
                              placeholder="users"
                            />
                          </label>
                        </div>

                        {(mongoMutationForm.operation === 'updateOne' ||
                          mongoMutationForm.operation === 'updateMany' ||
                          mongoMutationForm.operation === 'deleteOne' ||
                          mongoMutationForm.operation === 'deleteMany') && (
                          <label className="field">
                            <span>Filter JSON</span>
                            <textarea
                              rows={6}
                              value={mongoMutationForm.filter}
                              onChange={(event) =>
                                updateMongoMutation('filter', event.target.value)
                              }
                            />
                          </label>
                        )}

                        {(mongoMutationForm.operation === 'updateOne' ||
                          mongoMutationForm.operation === 'updateMany') && (
                          <>
                            <label className="field">
                              <span>Update JSON</span>
                              <textarea
                                rows={7}
                                value={mongoMutationForm.update}
                                onChange={(event) =>
                                  updateMongoMutation('update', event.target.value)
                                }
                              />
                            </label>
                            <label className="db-checkbox">
                              <input
                                type="checkbox"
                                checked={mongoMutationForm.upsert}
                                onChange={(event) =>
                                  updateMongoMutation('upsert', event.target.checked)
                                }
                              />
                              <span>Upsert if no document matches</span>
                            </label>
                          </>
                        )}

                        {mongoMutationForm.operation === 'insertOne' && (
                          <label className="field">
                            <span>Document JSON</span>
                            <textarea
                              rows={8}
                              value={mongoMutationForm.document}
                              onChange={(event) =>
                                updateMongoMutation('document', event.target.value)
                              }
                            />
                          </label>
                        )}

                        {mongoMutationForm.operation === 'insertMany' && (
                          <label className="field">
                            <span>Documents JSON array</span>
                            <textarea
                              rows={9}
                              value={mongoMutationForm.documents}
                              onChange={(event) =>
                                updateMongoMutation('documents', event.target.value)
                              }
                            />
                          </label>
                        )}
                      </>
                    )}

                    <div className="db-toolbar">
                      <button
                        className="btn btn--primary btn--sm"
                        onClick={() => previewAction('mutate')}
                        disabled={mutationBusy || masterKeyMissing}
                      >
                        {mutationBusy ? 'Preparing…' : 'Preview mutation'}
                      </button>
                    </div>

                    {mutationError && <SectionNotice tone="error">{mutationError}</SectionNotice>}
                    {mutationResult && (
                      <>
                        <div className="db-subhead">Mutation result</div>
                        <JsonBlock value={mutationResult} />
                      </>
                    )}
                  </div>
                )}

                {activeTab === 'migrate' && selectedConnection && (
                  <div className="db-stack">
                    {selectedConnection.engine === 'mysql' ? (
                      <label className="field">
                        <span>MySQL migration SQL</span>
                        <textarea
                          rows={10}
                          value={mysqlMigrationSql}
                          onChange={(event) => setMysqlMigrationSql(event.target.value)}
                          placeholder={'CREATE TABLE example (\n  id INT PRIMARY KEY\n);\nALTER TABLE example ADD COLUMN name VARCHAR(255);'}
                        />
                        <span className="hint">Separate statements with semicolons. Only CREATE, ALTER, DROP, TRUNCATE, and RENAME are accepted.</span>
                      </label>
                    ) : (
                      <label className="field">
                        <span>MongoDB migration steps JSON array</span>
                        <textarea
                          rows={12}
                          value={mongoMigrationJson}
                          onChange={(event) => setMongoMigrationJson(event.target.value)}
                        />
                        <span className="hint">Use createCollection, dropCollection, renameCollection, createIndex, dropIndex, or mutation steps.</span>
                      </label>
                    )}

                    <div className="db-toolbar">
                      <button
                        className="btn btn--primary btn--sm"
                        onClick={() => previewAction('migrate')}
                        disabled={migrationBusy || masterKeyMissing}
                      >
                        {migrationBusy ? 'Preparing…' : 'Preview migration'}
                      </button>
                    </div>

                    {migrationError && <SectionNotice tone="error">{migrationError}</SectionNotice>}
                    {migrationResult && (
                      <>
                        <div className="db-subhead">Migration result</div>
                        <JsonBlock value={migrationResult} />
                      </>
                    )}
                  </div>
                )}

                {activeTab === 'backup' && selectedConnection && (
                  <div className="db-stack">
                    <div className="db-split">
                      <div className="db-split__panel">
                        <h4>Backup</h4>
                        <label className="field">
                          <span>Database override (optional)</span>
                          <input
                            value={backupDatabase}
                            onChange={(event) => setBackupDatabase(event.target.value)}
                            placeholder={selectedConnection.summary.database}
                          />
                        </label>
                        <button
                          className="btn btn--primary btn--sm"
                          onClick={() => previewAction('backup')}
                          disabled={backupBusy || masterKeyMissing}
                        >
                          {backupBusy ? 'Preparing…' : 'Preview backup'}
                        </button>
                        {backupError && <SectionNotice tone="error">{backupError}</SectionNotice>}
                        {backupResult && (
                          <>
                            <div className="db-subhead">Backup result</div>
                            <JsonBlock value={backupResult} />
                          </>
                        )}
                      </div>

                      <div className="db-split__panel">
                        <h4>Restore</h4>
                        <label className="field">
                          <span>Backup job</span>
                          <select
                            value={restoreJobId}
                            onChange={(event) => setRestoreJobId(event.target.value)}
                          >
                            <option value="">Select a backup job…</option>
                            {backupJobs.map((job) => (
                              <option key={job.id} value={job.id}>
                                {job.id} · {job.summary}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field">
                          <span>Target database (optional)</span>
                          <input
                            value={restoreTargetDatabase}
                            onChange={(event) => setRestoreTargetDatabase(event.target.value)}
                            placeholder={selectedConnection.summary.database}
                          />
                        </label>
                        <button
                          className="btn btn--primary btn--sm"
                          onClick={() => previewAction('restore')}
                          disabled={restoreBusy || !restoreJobId || masterKeyMissing}
                        >
                          {restoreBusy ? 'Preparing…' : 'Preview restore'}
                        </button>
                        {restoreError && <SectionNotice tone="error">{restoreError}</SectionNotice>}
                        {restoreResult && (
                          <>
                            <div className="db-subhead">Restore result</div>
                            <JsonBlock value={restoreResult} />
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'activity' && selectedConnection && (
                  <div className="db-stack">
                    <div className="db-activity-panel">
                      <div className="db-activity-panel__head">
                        <h3>Connection operations</h3>
                        <span className="muted">{connectionOperations.length} loaded</span>
                      </div>
                      <OperationsTable
                        operations={connectionOperations}
                        emptyLabel="No operations recorded for this connection."
                      />
                    </div>
                    <div className="db-activity-panel">
                      <div className="db-activity-panel__head">
                        <h3>Connection jobs</h3>
                        <span className="muted">{connectionJobs.length} loaded</span>
                      </div>
                      <JobsTable
                        jobs={connectionJobs}
                        emptyLabel="No backup or restore jobs recorded for this connection."
                      />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </section>
      )}

      {pendingConfirmation && (
        <div className="modal-backdrop" onClick={() => !confirming && setPendingConfirmation(null)}>
          <div className="modal modal--detail" onClick={(event) => event.stopPropagation()}>
            <div className="modal__head">
              <h3>Confirm {pendingConfirmation.kind}</h3>
              <button
                className="btn btn--ghost"
                onClick={() => setPendingConfirmation(null)}
                disabled={confirming}
              >
                Close
              </button>
            </div>
            <SectionNotice tone="warning">{pendingConfirmation.summary}</SectionNotice>
            <div className="db-subhead">Request preview</div>
            <JsonBlock value={pendingConfirmation.request} />
            <div className="modal__foot">
              <span className="muted">Review the preview before continuing.</span>
              <div>
                <button
                  className="btn btn--ghost"
                  onClick={() => setPendingConfirmation(null)}
                  disabled={confirming}
                >
                  Cancel
                </button>
                <button
                  className="btn btn--primary"
                  onClick={confirmPending}
                  disabled={confirming}
                >
                  {confirming ? 'Running…' : 'Confirm and run'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
