import type Anthropic from '@anthropic-ai/sdk';
import { getDatabaseJob } from './db.js';
import {
  getConnectionDetail,
  getOperationsOverview,
  inspectSavedConnectionSchema,
  listConnectionDetails,
  listJobOverviews,
  runSavedConnectionRead,
  testSavedConnection,
} from './databaseManagement.js';

export const DATABASE_ASSISTANT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_database_connections',
    description:
      'List saved MySQL and MongoDB connections (id, name, engine, summary, last test status). Use this to resolve a friendly connection name to its id.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_database_connection',
    description:
      'Read one saved database connection by id, without revealing encrypted credentials.',
    input_schema: {
      type: 'object',
      properties: { connectionId: { type: 'string', description: 'Saved connection id, e.g. dbc-abc12345' } },
      required: ['connectionId'],
    },
  },
  {
    name: 'get_database_operations_overview',
    description:
      'Read the database-management overview: saved connections, recent mutation/migration operations, recent backup/restore jobs, and server limits.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'inspect_database_schema',
    description:
      'Inspect schema/metadata for a saved MySQL or MongoDB connection. For MySQL, returns databases, tables, columns, and indexes. For MongoDB, returns databases, collections, sampled fields, and indexes.',
    input_schema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: 'Saved connection id' },
        database: { type: 'string', description: 'Optional database override; otherwise use the saved default database' },
      },
      required: ['connectionId'],
    },
  },
  {
    name: 'run_database_read_query',
    description:
      'Run a bounded read-only query against a saved connection. MySQL: provide `sql` (single read-only statement). MongoDB: provide `collection`, optional `database`, `mode` (`find`, `aggregate`, or `count`), plus JSON `filter` / `projection` / `sort` / `pipeline` / `limit` as appropriate.',
    input_schema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: 'Saved connection id' },
        sql: { type: 'string', description: 'MySQL only: one read-only SQL statement' },
        database: { type: 'string', description: 'MongoDB only: optional database override' },
        collection: { type: 'string', description: 'MongoDB only: collection name' },
        mode: { type: 'string', enum: ['find', 'aggregate', 'count'], description: 'MongoDB only; defaults to find' },
        filter: { type: 'object', description: 'MongoDB find/count filter' },
        projection: { type: 'object', description: 'MongoDB find projection' },
        sort: { type: 'object', description: 'MongoDB find sort with 1/-1 values' },
        limit: { type: 'number', description: 'MongoDB read limit; server caps it' },
        pipeline: { type: 'array', description: 'MongoDB aggregate pipeline', items: { type: 'object' } },
      },
      required: ['connectionId'],
    },
  },
  {
    name: 'list_database_jobs',
    description:
      'List recent backup and restore jobs, including status and whether an artifact is available.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Optional result limit, max 100' },
      },
      required: [],
    },
  },
  {
    name: 'get_database_job',
    description:
      'Read one backup or restore job by id.',
    input_schema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'Database job id, e.g. dbj-abc12345' } },
      required: ['jobId'],
    },
  },
  {
    name: 'create_database_connection',
    description:
      'Create a saved MySQL or MongoDB connection. Credentials are encrypted at rest with DOCKYARD_DATABASE_MASTER_KEY.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Friendly connection name' },
        engine: { type: 'string', enum: ['mysql', 'mongodb'] },
        config: {
          type: 'object',
          description:
            'For MySQL: { host, port?, database, username, password?, ssl? }. For MongoDB field mode: { mode:"fields", host, port?, database, username?, password?, authDatabase?, directConnection?, tls? }. For MongoDB URI mode: { mode:"uri", uri, database }.',
        },
      },
      required: ['name', 'engine', 'config'],
    },
  },
  {
    name: 'update_database_connection',
    description:
      'Update a saved database connection. Omitted secret fields keep their stored values.',
    input_schema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        name: { type: 'string' },
        engine: { type: 'string', enum: ['mysql', 'mongodb'] },
        config: { type: 'object' },
      },
      required: ['connectionId'],
    },
  },
  {
    name: 'delete_database_connection',
    description: 'Delete a saved database connection by id.',
    input_schema: {
      type: 'object',
      properties: { connectionId: { type: 'string' } },
      required: ['connectionId'],
    },
  },
  {
    name: 'test_database_connection',
    description: 'Test a saved MySQL or MongoDB connection and persist the latest health status.',
    input_schema: {
      type: 'object',
      properties: { connectionId: { type: 'string' } },
      required: ['connectionId'],
    },
  },
  {
    name: 'execute_database_mutation',
    description:
      'Run a confirmed data mutation against a saved connection. MySQL: { connectionId, statement }. MongoDB: { connectionId, operation, collection, database?, ...operation-specific fields } where operation is insertOne/insertMany/updateOne/updateMany/deleteOne/deleteMany.',
    input_schema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        statement: { type: 'string', description: 'MySQL only: one INSERT/UPDATE/DELETE/REPLACE statement' },
        operation: { type: 'string', enum: ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'] },
        database: { type: 'string' },
        collection: { type: 'string' },
        document: { type: 'object' },
        documents: { type: 'array', items: { type: 'object' } },
        filter: { type: 'object' },
        update: { type: 'object' },
        upsert: { type: 'boolean' },
      },
      required: ['connectionId'],
    },
  },
  {
    name: 'execute_database_migration',
    description:
      'Run a confirmed schema or multi-step migration against a saved connection. MySQL: { connectionId, statements:[...] }. MongoDB: { connectionId, steps:[...] } with createCollection/dropCollection/renameCollection/createIndex/dropIndex and the supported mutation step shapes.',
    input_schema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        statements: { type: 'array', items: { type: 'string' }, description: 'MySQL migration statements' },
        steps: { type: 'array', items: { type: 'object' }, description: 'MongoDB migration steps' },
      },
      required: ['connectionId'],
    },
  },
  {
    name: 'execute_database_access_grant',
    description:
      'Preview then execute a structured database access grant against a saved connection. MySQL: { connectionId, username, host, privileges:[...], database, table?, withGrantOption? } to build a safe GRANT statement. MongoDB: { connectionId, username, authDatabase, roles:[builtInRoleString | { role, db }] } to call grantRolesToUser. Client executors should first preview this request and only send the same payload with confirmed:true after explicit user confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        username: { type: 'string', description: 'Target MySQL or MongoDB username' },
        host: { type: 'string', description: 'MySQL only: account host, e.g. localhost or %' },
        privileges: {
          type: 'array',
          description: 'MySQL only: privilege names such as SELECT, INSERT, UPDATE, ALL PRIVILEGES',
          items: { type: 'string' },
        },
        database: { type: 'string', description: 'MySQL only: database scope, or * for global scope' },
        table: { type: 'string', description: 'MySQL only: optional table scope, defaults to *' },
        withGrantOption: { type: 'boolean', description: 'MySQL only: append WITH GRANT OPTION' },
        authDatabase: { type: 'string', description: 'MongoDB only: database that owns the target user' },
        roles: {
          type: 'array',
          description: 'MongoDB only: built-in role strings or { role, db } objects',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  role: { type: 'string' },
                  db: { type: 'string' },
                },
                required: ['role', 'db'],
              },
            ],
          },
        },
      },
      required: ['connectionId', 'username'],
    },
  },
  {
    name: 'create_database_backup',
    description:
      'Create a confirmed backup job for a saved connection. The built-in exporter is intended for smaller datasets and stores a JSON/EJSON artifact on the Dockyard server.',
    input_schema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        database: { type: 'string', description: 'Optional database override' },
      },
      required: ['connectionId'],
    },
  },
  {
    name: 'restore_database_backup',
    description:
      'Run a confirmed restore job from a prior backup artifact into a saved connection. Provide the backup job id and, optionally, a target database name.',
    input_schema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        jobId: { type: 'string', description: 'Backup job id to restore from' },
        targetDatabase: { type: 'string', description: 'Optional target database name' },
      },
      required: ['connectionId', 'jobId'],
    },
  },
];

export const DATABASE_ASSISTANT_READ_ONLY_TOOLS = new Set([
  'list_database_connections',
  'get_database_connection',
  'get_database_operations_overview',
  'inspect_database_schema',
  'run_database_read_query',
  'list_database_jobs',
  'get_database_job',
]);

function limitValue(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1 || num > 100) return 25;
  return num;
}

export async function executeDatabaseAssistantReadOnlyTool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'list_database_connections':
      return listConnectionDetails();
    case 'get_database_connection':
      return getConnectionDetail(String(input.connectionId ?? ''));
    case 'get_database_operations_overview':
      return getOperationsOverview();
    case 'inspect_database_schema':
      return inspectSavedConnectionSchema(String(input.connectionId ?? ''), input.database);
    case 'run_database_read_query': {
      const { connectionId, ...request } = input;
      return runSavedConnectionRead(String(connectionId ?? ''), request);
    }
    case 'list_database_jobs':
      return listJobOverviews(limitValue(input.limit));
    case 'get_database_job': {
      const row = getDatabaseJob(String(input.jobId ?? ''));
      if (!row) throw new Error('Database job not found.');
      return listJobOverviews(500).find((entry) => (entry as { id: string }).id === row.id) ?? row;
    }
    default:
      throw new Error(`Unknown database assistant read-only tool "${name}".`);
  }
}

export async function executeDatabaseAssistantTestTool(input: Record<string, unknown>): Promise<unknown> {
  return testSavedConnection(String(input.connectionId ?? ''));
}
