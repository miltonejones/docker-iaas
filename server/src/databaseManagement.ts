import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql, { type FieldPacket, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import {
  Binary,
  Decimal128,
  Double,
  Int32,
  Long,
  MongoClient,
  ObjectId,
  Timestamp,
} from 'mongodb';
import { EJSON } from 'bson';
import {
  getDatabaseConnection,
  getDatabaseJob,
  listDatabaseConnections,
  listDatabaseJobs,
  listDatabaseOperations,
  listDatabaseOperationsForConnection,
  setDatabaseConnectionTestResult,
  type DatabaseConnectionRow,
  type DatabaseJobRow,
  type DatabaseOperationRow,
} from './db.js';

export type DatabaseEngine = 'mysql' | 'mongodb';

type JsonObject = Record<string, unknown>;

type SortDirection = 1 | -1;

export const DATABASE_LIMITS = {
  maxReadRows: 200,
  maxReadStringChars: 4_000,
  maxReadJsonBytes: 256_000,
  maxReadArrayItems: 100,
  maxReadObjectKeys: 100,
  maxSchemaDatabases: 100,
  maxSchemaTables: 100,
  maxSchemaCollections: 100,
  maxSchemaColumnsPerTable: 200,
  maxSchemaFieldPathsPerCollection: 200,
  maxMongoSampleDocs: 25,
  maxMongoPipelineStages: 25,
  maxMutationSteps: 20,
  maxInsertManyDocuments: 200,
  maxBackupArtifactBytes: 25 * 1024 * 1024,
  maxBackupEstimatedRows: 20_000,
  maxQueryPayloadBytes: 64_000,
  maxQueryTimeMs: 8_000,
} as const;

export const DATABASE_MASTER_KEY_ERROR =
  'DOCKYARD_DATABASE_MASTER_KEY is required for saved database connections and database operations.';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.resolve(__dirname, '../../data/database-backups');

const CONNECTION_ID_RE = /^dbc-[a-z0-9]{8}$/;
const JOB_ID_RE = /^dbj-[a-z0-9]{8}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;
const HOST_RE = /^(localhost|[A-Za-z0-9][A-Za-z0-9.-]{0,252}[A-Za-z0-9])$/;
const IDENTIFIER_RE = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,63}$/;
const INDEX_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:$-]{0,127}$/;
const MYSQL_GRANT_USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@$-]{0,63}$/;
const MYSQL_GRANT_HOST_RE = /^[A-Za-z0-9.%:_-]{1,255}$/;
const MYSQL_GRANT_PRIVILEGE_RE = /^(ALL PRIVILEGES|[A-Z_]+(?: [A-Z_]+)*)$/;
const MONGO_GRANT_USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@$-]{0,127}$/;
const MONGO_ROLE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@$:-]{0,127}$/;
const MONGO_BUILT_IN_ROLE_NAMES = [
  'read',
  'readWrite',
  'dbAdmin',
  'dbOwner',
  'userAdmin',
  'clusterAdmin',
  'clusterManager',
  'clusterMonitor',
  'hostManager',
  'backup',
  'restore',
  'readAnyDatabase',
  'readWriteAnyDatabase',
  'userAdminAnyDatabase',
  'dbAdminAnyDatabase',
  'root',
  '__system',
  'enableSharding',
  'directShardOperations',
  'searchCoordinator',
] as const;
const MONGO_BUILT_IN_ROLE_LOOKUP = new Map(
  MONGO_BUILT_IN_ROLE_NAMES.map((role) => [role.toLowerCase(), role] as const),
);

const READ_ONLY_SQL_RE = /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i;
const SQL_MUTATION_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
const SQL_MIGRATION_VERBS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME']);

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface BaseConnectionConfig {
  engine: DatabaseEngine;
  database: string;
}

export interface MySqlConnectionConfig extends BaseConnectionConfig {
  engine: 'mysql';
  host: string;
  port: number;
  username: string;
  password: string;
  ssl: boolean;
}

export interface MongoFieldsConnectionConfig extends BaseConnectionConfig {
  engine: 'mongodb';
  mode: 'fields';
  host: string;
  port: number;
  username: string;
  password: string;
  authDatabase: string;
  directConnection: boolean;
  tls: boolean;
}

export interface MongoUriConnectionConfig extends BaseConnectionConfig {
  engine: 'mongodb';
  mode: 'uri';
  uri: string;
}

export type MongoConnectionConfig = MongoFieldsConnectionConfig | MongoUriConnectionConfig;
export type StoredConnectionConfig = MySqlConnectionConfig | MongoConnectionConfig;

export interface DatabaseConnectionSummary {
  engine: DatabaseEngine;
  database: string;
  host?: string;
  port?: number;
  username?: string;
  ssl?: boolean;
  mode?: 'fields' | 'uri';
  uriRedacted?: string;
  authDatabase?: string;
  directConnection?: boolean;
  tls?: boolean;
  hasPassword: boolean;
}

export interface DatabaseConnectionDetail {
  id: string;
  name: string;
  engine: DatabaseEngine;
  summary: DatabaseConnectionSummary;
  createdAt: string;
  updatedAt: string;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  lastTestError: string | null;
}

export interface MySqlReadRequest {
  sql: string;
}

export interface MongoFindReadRequest {
  mode?: 'find';
  database?: string;
  collection: string;
  filter?: JsonObject;
  projection?: JsonObject;
  sort?: Record<string, SortDirection>;
  limit?: number;
}

export interface MongoAggregateReadRequest {
  mode: 'aggregate';
  database?: string;
  collection: string;
  pipeline: JsonObject[];
  limit?: number;
}

export interface MongoCountReadRequest {
  mode: 'count';
  database?: string;
  collection: string;
  filter?: JsonObject;
}

export type MongoReadRequest = MongoFindReadRequest | MongoAggregateReadRequest | MongoCountReadRequest;

export interface MySqlMutationRequest {
  statement: string;
  confirmed?: boolean;
}

export interface MySqlMigrationRequest {
  statements: string[];
  confirmed?: boolean;
}

type MongoMutationOperation =
  | { operation: 'insertOne'; database?: string; collection: string; document: JsonObject }
  | { operation: 'insertMany'; database?: string; collection: string; documents: JsonObject[] }
  | { operation: 'updateOne' | 'updateMany'; database?: string; collection: string; filter?: JsonObject; update: JsonObject; upsert?: boolean }
  | { operation: 'deleteOne' | 'deleteMany'; database?: string; collection: string; filter?: JsonObject };

type MongoMigrationStep =
  | MongoMutationOperation
  | { operation: 'createCollection'; database?: string; collection: string }
  | { operation: 'dropCollection'; database?: string; collection: string }
  | { operation: 'renameCollection'; database?: string; collection: string; to: string }
  | { operation: 'createIndex'; database?: string; collection: string; keys: Record<string, 1 | -1 | 'text' | 'hashed' | '2dsphere'>; options?: JsonObject }
  | { operation: 'dropIndex'; database?: string; collection: string; indexName: string };

export interface MongoMutationRequest {
  confirmed?: boolean;
  operation: MongoMutationOperation['operation'];
  database?: string;
  collection: string;
  document?: JsonObject;
  documents?: JsonObject[];
  filter?: JsonObject;
  update?: JsonObject;
  upsert?: boolean;
}

export interface MongoMigrationRequest {
  confirmed?: boolean;
  steps: MongoMigrationStep[];
}

export interface MySqlGrantRequest {
  confirmed?: boolean;
  username: string;
  host: string;
  privileges: string[];
  database: string;
  table?: string;
  withGrantOption?: boolean;
}

export type MongoGrantRole = string | { role: string; db: string };

export interface MongoRoleGrantRequest {
  confirmed?: boolean;
  username: string;
  authDatabase: string;
  roles: MongoGrantRole[];
}

export interface BackupRequest {
  confirmed?: boolean;
  database?: string;
}

export interface RestoreRequest {
  confirmed?: boolean;
  jobId: string;
  targetDatabase?: string;
}

interface MySqlBackupArtifact {
  version: 1;
  engine: 'mysql';
  format: 'dockyard.mysql.json';
  createdAt: string;
  database: string;
  sourceConnection: { id: string; name: string };
  tables: Array<{
    name: string;
    createStatement: string;
    rowCount: number;
    rows: JsonObject[];
  }>;
}

interface MongoBackupArtifact {
  version: 1;
  engine: 'mongodb';
  format: 'dockyard.mongodb.ejson';
  createdAt: string;
  database: string;
  sourceConnection: { id: string; name: string };
  collections: Array<{
    name: string;
    indexes: JsonObject[];
    documents: unknown[];
  }>;
}

function ensureText(value: unknown, label: string, maxLength = 16_000): string {
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) throw new HttpError(400, `${label} is required.`);
  if (trimmed.length > maxLength) throw new HttpError(400, `${label} is too long.`);
  return trimmed;
}

function ensureOptionalText(value: unknown, label: string, maxLength = 16_000): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a string.`);
  if (value.length > maxLength) throw new HttpError(400, `${label} is too long.`);
  return value;
}

function ensureBoolean(value: unknown, label: string, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') throw new HttpError(400, `${label} must be a boolean.`);
  return value;
}

function ensurePort(value: unknown, label: string, defaultValue: number): number {
  if (value === undefined || value === null || value === '') return defaultValue;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1 || num > 65_535) {
    throw new HttpError(400, `${label} must be an integer between 1 and 65535.`);
  }
  return num;
}

function ensureConnectionName(value: unknown): string {
  const name = ensureText(value, 'Connection name', 80);
  if (!NAME_RE.test(name)) {
    throw new HttpError(400, 'Connection name may only contain letters, digits, spaces, ., _, and -.' );
  }
  return name;
}

function ensureHost(value: unknown): string {
  const host = ensureText(value, 'Host', 255);
  if (!HOST_RE.test(host)) {
    throw new HttpError(400, 'Host must be localhost or a DNS-style hostname.' );
  }
  return host;
}

export function ensureManagedIdentifier(value: unknown, label: string): string {
  const text = ensureText(value, label, 64);
  if (!IDENTIFIER_RE.test(text)) {
    throw new HttpError(400, `${label} may only contain letters, digits, _, $, and - and must not start with punctuation.`);
  }
  return text;
}

function ensureManagedIdentifierOrWildcard(value: unknown, label: string): string {
  const text = ensureText(value, label, 64);
  return text === '*' ? text : ensureManagedIdentifier(text, label);
}

export function ensureConnectionId(value: unknown): string {
  const id = ensureText(value, 'Connection id', 32);
  if (!CONNECTION_ID_RE.test(id)) throw new HttpError(400, 'Invalid connection id.' );
  return id;
}

export function ensureJobId(value: unknown): string {
  const id = ensureText(value, 'Job id', 32);
  if (!JOB_ID_RE.test(id)) throw new HttpError(400, 'Invalid job id.' );
  return id;
}

function ensureIndexName(value: unknown): string {
  const name = ensureText(value, 'Index name', 128);
  if (!INDEX_NAME_RE.test(name)) throw new HttpError(400, 'Index name contains unsupported characters.' );
  return name;
}

function ensureMySqlGrantUsername(value: unknown): string {
  const username = ensureText(value, 'username', 64);
  if (!MYSQL_GRANT_USERNAME_RE.test(username)) {
    throw new HttpError(400, 'username contains unsupported characters for a MySQL account.');
  }
  return username;
}

function ensureMySqlGrantHost(value: unknown): string {
  const host = ensureText(value, 'host', 255);
  if (!MYSQL_GRANT_HOST_RE.test(host)) {
    throw new HttpError(400, 'host contains unsupported characters for a MySQL account.');
  }
  return host;
}

function ensureMongoGrantUsername(value: unknown): string {
  const username = ensureText(value, 'username', 128);
  if (!MONGO_GRANT_USERNAME_RE.test(username)) {
    throw new HttpError(400, 'username contains unsupported characters for a MongoDB user.');
  }
  return username;
}

function ensureMongoRoleName(value: unknown, label: string): string {
  const role = ensureText(value, label, 128);
  if (!MONGO_ROLE_NAME_RE.test(role)) {
    throw new HttpError(400, `${label} contains unsupported characters.`);
  }
  return role;
}

function isPlainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ensurePlainObject(value: unknown, label: string): JsonObject {
  if (!isPlainObject(value)) throw new HttpError(400, `${label} must be a JSON object.`);
  const encoded = JSON.stringify(value);
  if (encoded.length > DATABASE_LIMITS.maxQueryPayloadBytes) {
    throw new HttpError(400, `${label} is too large.`);
  }
  return value;
}

function ensureOptionalPlainObject(value: unknown, label: string): JsonObject | undefined {
  if (value === undefined) return undefined;
  return ensurePlainObject(value, label);
}

function ensureSort(value: unknown): Record<string, SortDirection> | undefined {
  if (value === undefined) return undefined;
  const sort = ensurePlainObject(value, 'sort');
  const entries = Object.entries(sort);
  for (const [key, dir] of entries) {
    if (!key || key.length > 128) throw new HttpError(400, 'sort keys must be non-empty and short.' );
    if (dir !== 1 && dir !== -1) throw new HttpError(400, 'sort values must be 1 or -1.' );
  }
  return sort as Record<string, SortDirection>;
}

function ensureArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be an array.`);
  return value as T[];
}

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newConnectionId(): string {
  return randomId('dbc');
}

export function newOperationId(): string {
  return randomId('dbo');
}

export function newJobId(): string {
  return randomId('dbj');
}

function readMasterSecret(): string | undefined {
  const environmentSecret = process.env.DOCKYARD_DATABASE_MASTER_KEY?.trim();
  if (environmentSecret) return environmentSecret;

  const secretFile = process.env.DOCKYARD_DATABASE_MASTER_KEY_FILE
    || '/run/secrets/dockyard_database_master_key';
  try {
    const fileSecret = fsSync.readFileSync(secretFile, 'utf8').trim();
    return fileSecret || undefined;
  } catch {
    return undefined;
  }
}

function resolveMasterKey(): Buffer {
  const secret = readMasterSecret();
  if (!secret?.trim()) throw new HttpError(503, DATABASE_MASTER_KEY_ERROR);
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptConfig(config: StoredConnectionConfig): string {
  const key = resolveMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(config), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

function decryptConfig(payload: string): StoredConnectionConfig {
  const key = resolveMasterKey();
  try {
    const parsed = JSON.parse(payload) as {
      iv: string;
      tag: string;
      ciphertext: string;
    };
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parsed.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as StoredConnectionConfig;
  } catch {
    throw new HttpError(
      500,
      'Saved database credentials could not be decrypted. Check DOCKYARD_DATABASE_MASTER_KEY.',
    );
  }
}

function redactMongoUri(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    return url.toString();
  } catch {
    return uri.replace(/\/\/([^@/]+)@/, '//***:***@');
  }
}

function buildMongoUri(config: MongoConnectionConfig): string {
  if (config.mode === 'uri') return config.uri;
  const auth = config.username
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
    : '';
  const params = new URLSearchParams();
  if (config.authDatabase) params.set('authSource', config.authDatabase);
  if (config.directConnection) params.set('directConnection', 'true');
  if (config.tls) params.set('tls', 'true');
  const query = params.toString();
  return `mongodb://${auth}${config.host}:${config.port}/${config.database}${query ? `?${query}` : ''}`;
}

function buildSummary(config: StoredConnectionConfig): DatabaseConnectionSummary {
  if (config.engine === 'mysql') {
    return {
      engine: 'mysql',
      database: config.database,
      host: config.host,
      port: config.port,
      username: config.username,
      ssl: config.ssl,
      hasPassword: config.password.length > 0,
    };
  }
  if (config.mode === 'uri') {
    return {
      engine: 'mongodb',
      mode: 'uri',
      database: config.database,
      uriRedacted: redactMongoUri(config.uri),
      hasPassword: /\/\/[^/]*:[^@]*@/.test(config.uri),
    };
  }
  return {
    engine: 'mongodb',
    mode: 'fields',
    database: config.database,
    host: config.host,
    port: config.port,
    username: config.username || undefined,
    authDatabase: config.authDatabase,
    directConnection: config.directConnection,
    tls: config.tls,
    hasPassword: config.password.length > 0,
  };
}

function parseSummary(row: DatabaseConnectionRow): DatabaseConnectionSummary {
  try {
    return JSON.parse(row.summary_json) as DatabaseConnectionSummary;
  } catch {
    throw new HttpError(500, `Saved database connection "${row.name}" has invalid summary metadata.`);
  }
}

function toDetail(row: DatabaseConnectionRow): DatabaseConnectionDetail {
  return {
    id: row.id,
    name: row.name,
    engine: row.engine as DatabaseEngine,
    summary: parseSummary(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTestedAt: row.last_tested_at,
    lastTestStatus: row.last_test_status,
    lastTestError: row.last_test_error,
  };
}

function ensureDatabaseEngine(value: unknown): DatabaseEngine {
  if (value !== 'mysql' && value !== 'mongodb') {
    throw new HttpError(400, 'engine must be either "mysql" or "mongodb".' );
  }
  return value;
}

function normalizeMySqlConfig(input: JsonObject, existing?: MySqlConnectionConfig): MySqlConnectionConfig {
  const host = input.host !== undefined ? ensureHost(input.host) : existing?.host;
  const port = ensurePort(input.port, 'port', existing?.port ?? 3306);
  const database = input.database !== undefined
    ? ensureManagedIdentifier(input.database, 'database')
    : existing?.database;
  const username = input.username !== undefined ? ensureText(input.username, 'username', 128) : existing?.username;
  const password = input.password !== undefined ? ensureOptionalText(input.password, 'password', 4_000) ?? '' : existing?.password ?? '';
  const ssl = input.ssl !== undefined ? ensureBoolean(input.ssl, 'ssl') : existing?.ssl ?? false;
  if (!host || !database || !username) {
    throw new HttpError(400, 'MySQL connections require host, database, and username.' );
  }
  return { engine: 'mysql', host, port, database, username, password, ssl };
}

function normalizeMongoConfig(input: JsonObject, existing?: MongoConnectionConfig): MongoConnectionConfig {
  const mode = input.mode === 'uri' || input.uri !== undefined
    ? 'uri'
    : input.mode === 'fields'
      ? 'fields'
      : existing?.mode ?? 'fields';

  if (mode === 'uri') {
    const uri = input.uri !== undefined ? ensureText(input.uri, 'uri', 4_000) : existing?.mode === 'uri' ? existing.uri : undefined;
    const database = input.database !== undefined
      ? ensureManagedIdentifier(input.database, 'database')
      : existing?.database;
    if (!uri || !database) {
      throw new HttpError(400, 'MongoDB uri-mode connections require uri and database.' );
    }
    if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
      throw new HttpError(400, 'MongoDB uri must start with mongodb:// or mongodb+srv://.' );
    }
    return { engine: 'mongodb', mode: 'uri', uri, database };
  }

  const host = input.host !== undefined ? ensureHost(input.host) : existing?.mode === 'fields' ? existing.host : undefined;
  const port = ensurePort(input.port, 'port', existing?.mode === 'fields' ? existing.port : 27017);
  const database = input.database !== undefined
    ? ensureManagedIdentifier(input.database, 'database')
    : existing?.database;
  const username = input.username !== undefined ? ensureOptionalText(input.username, 'username', 128) ?? '' : existing?.mode === 'fields' ? existing.username : '';
  const password = input.password !== undefined ? ensureOptionalText(input.password, 'password', 4_000) ?? '' : existing?.mode === 'fields' ? existing.password : '';
  const authDatabase = input.authDatabase !== undefined
    ? ensureManagedIdentifier(input.authDatabase, 'authDatabase')
    : existing?.mode === 'fields'
      ? existing.authDatabase
      : database;
  const directConnection = input.directConnection !== undefined
    ? ensureBoolean(input.directConnection, 'directConnection')
    : existing?.mode === 'fields'
      ? existing.directConnection
      : false;
  const tls = input.tls !== undefined
    ? ensureBoolean(input.tls, 'tls')
    : existing?.mode === 'fields'
      ? existing.tls
      : false;
  if (!host || !database) {
    throw new HttpError(400, 'MongoDB field-mode connections require host and database.' );
  }
  return {
    engine: 'mongodb',
    mode: 'fields',
    host,
    port,
    database,
    username,
    password,
    authDatabase: authDatabase || database,
    directConnection,
    tls,
  };
}

export function normalizeConnectionInput(body: unknown, existing?: StoredConnectionConfig): {
  name: string;
  engine: DatabaseEngine;
  config: StoredConnectionConfig;
  summary: DatabaseConnectionSummary;
} {
  const payload = ensurePlainObject(body, 'request body');
  const name = payload.name !== undefined ? ensureConnectionName(payload.name) : undefined;
  const engine = payload.engine !== undefined ? ensureDatabaseEngine(payload.engine) : existing?.engine;
  if (!name) throw new HttpError(400, 'Connection name is required.' );
  if (!engine) throw new HttpError(400, 'engine is required.' );
  const configInput = ensurePlainObject(payload.config, 'config');
  const config = engine === 'mysql'
    ? normalizeMySqlConfig(configInput, existing?.engine === 'mysql' ? existing : undefined)
    : normalizeMongoConfig(configInput, existing?.engine === 'mongodb' ? existing : undefined);
  return { name, engine, config, summary: buildSummary(config) };
}

export function applyConnectionUpdate(row: DatabaseConnectionRow, body: unknown): {
  name: string;
  engine: DatabaseEngine;
  config: StoredConnectionConfig;
  summary: DatabaseConnectionSummary;
} {
  const existing = decryptConfig(row.encrypted_config);
  const payload = ensurePlainObject(body, 'request body');
  const name = payload.name !== undefined ? ensureConnectionName(payload.name) : row.name;
  const engine = payload.engine !== undefined ? ensureDatabaseEngine(payload.engine) : existing.engine;
  const configInput = payload.config === undefined ? {} : ensurePlainObject(payload.config, 'config');
  const config = engine === 'mysql'
    ? normalizeMySqlConfig(configInput, existing.engine === 'mysql' ? existing : undefined)
    : normalizeMongoConfig(configInput, existing.engine === 'mongodb' ? existing : undefined);
  return { name, engine, config, summary: buildSummary(config) };
}

export function listConnectionDetails(): DatabaseConnectionDetail[] {
  return listDatabaseConnections().map(toDetail);
}

export function getConnectionDetail(id: string): DatabaseConnectionDetail {
  const row = getDatabaseConnection(ensureConnectionId(id));
  if (!row) throw new HttpError(404, 'Saved database connection not found.' );
  return toDetail(row);
}

export function getStoredConnection(id: string): { row: DatabaseConnectionRow; config: StoredConnectionConfig; detail: DatabaseConnectionDetail } {
  const row = getDatabaseConnection(ensureConnectionId(id));
  if (!row) throw new HttpError(404, 'Saved database connection not found.' );
  return { row, config: decryptConfig(row.encrypted_config), detail: toDetail(row) };
}

async function withMySql<T>(config: MySqlConnectionConfig, fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
    ssl: config.ssl ? {} : undefined,
    connectTimeout: DATABASE_LIMITS.maxQueryTimeMs,
    multipleStatements: false,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => {});
  }
}

async function withMySqlAdmin<T>(config: MySqlConnectionConfig, fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    ssl: config.ssl ? {} : undefined,
    connectTimeout: DATABASE_LIMITS.maxQueryTimeMs,
    multipleStatements: false,
  });
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => {});
  }
}

async function withMongo<T>(config: MongoConnectionConfig, fn: (client: MongoClient) => Promise<T>): Promise<T> {
  const client = new MongoClient(buildMongoUri(config), {
    maxPoolSize: 4,
    serverSelectionTimeoutMS: DATABASE_LIMITS.maxQueryTimeMs,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function truncateString(value: string): string {
  return value.length <= DATABASE_LIMITS.maxReadStringChars
    ? value
    : `${value.slice(0, DATABASE_LIMITS.maxReadStringChars)}…`;
}

function sanitizeForResponse(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    const base64 = value.toString('base64');
    return { base64: truncateString(base64), bytes: value.length };
  }
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Binary) return { base64: truncateString(Buffer.from(value.buffer).toString('base64')), bytes: value.length() };
  if (value instanceof Decimal128 || value instanceof Long || value instanceof Double || value instanceof Int32 || value instanceof Timestamp) {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.slice(0, DATABASE_LIMITS.maxReadArrayItems).map((entry) => sanitizeForResponse(entry, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= 6) return '[MaxDepth]';
    const entries = Object.entries(value as Record<string, unknown>).slice(0, DATABASE_LIMITS.maxReadObjectKeys);
    return Object.fromEntries(entries.map(([key, entry]) => [key, sanitizeForResponse(entry, depth + 1)]));
  }
  return String(value);
}

function ensureReadPayloadSize(result: unknown): unknown {
  const encoded = JSON.stringify(result);
  if (encoded.length <= DATABASE_LIMITS.maxReadJsonBytes) return result;
  throw new HttpError(413, 'Query result exceeded the server response limit. Narrow the query and try again.' );
}

function normalizeSqlStatement(value: unknown, label: string): string {
  const statement = ensureText(value, label, 64_000).replace(/;+\s*$/, '').trim();
  if (statement.includes(';')) {
    throw new HttpError(400, `${label} must contain exactly one SQL statement.`);
  }
  return statement;
}

function firstSqlVerb(statement: string): string {
  const match = statement.match(/^([A-Za-z]+)/);
  if (!match) throw new HttpError(400, 'SQL statement is missing a leading verb.' );
  return match[1].toUpperCase();
}

function normalizeReadSql(value: unknown): string {
  const statement = normalizeSqlStatement(value, 'sql');
  const verb = firstSqlVerb(statement);
  if (!READ_ONLY_SQL_RE.test(statement)) {
    throw new HttpError(400, 'Only SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, and WITH queries are allowed here.' );
  }
  if (SQL_MUTATION_VERBS.has(verb) || SQL_MIGRATION_VERBS.has(verb)) {
    throw new HttpError(400, 'Only read-only SQL is allowed here.' );
  }
  return statement;
}

function normalizeMutationSql(value: unknown, allowed: Set<string>, label: string): string {
  const statement = normalizeSqlStatement(value, label);
  const verb = firstSqlVerb(statement);
  if (!allowed.has(verb)) {
    throw new HttpError(400, `${label} must start with ${Array.from(allowed).join(', ')}.`);
  }
  return statement;
}

function quotedMySqlIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function inferFieldMap(docs: unknown[]): Array<{ path: string; types: string[] }> {
  const map = new Map<string, Set<string>>();

  const visit = (value: unknown, prefix: string, depth: number) => {
    if (!prefix) return;
    const type =
      value instanceof ObjectId ? 'ObjectId'
        : value instanceof Date ? 'Date'
        : Array.isArray(value) ? 'array'
        : value === null ? 'null'
        : Buffer.isBuffer(value) || value instanceof Binary ? 'binary'
        : typeof value;
    const set = map.get(prefix) ?? new Set<string>();
    set.add(type);
    map.set(prefix, set);
    if (depth >= 3) return;
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 5)) visit(entry, `${prefix}[]`, depth + 1);
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value).slice(0, 20)) {
        visit(child, `${prefix}.${key}`, depth + 1);
      }
    }
  };

  for (const doc of docs) {
    if (!isPlainObject(doc)) continue;
    for (const [key, value] of Object.entries(doc).slice(0, 50)) {
      visit(value, key, 0);
    }
  }

  return Array.from(map.entries())
    .slice(0, DATABASE_LIMITS.maxSchemaFieldPathsPerCollection)
    .map(([fieldPath, types]) => ({ path: fieldPath, types: Array.from(types).sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function testSavedConnection(id: string): Promise<unknown> {
  const { config, detail } = getStoredConnection(id);
  try {
    const result = config.engine === 'mysql'
      ? await withMySql(config, async (conn) => {
          const [rows] = await conn.query<RowDataPacket[]>('SELECT DATABASE() AS currentDatabase, VERSION() AS version');
          return {
            ok: true,
            engine: 'mysql',
            connection: detail,
            currentDatabase: rows[0]?.currentDatabase ?? config.database,
            version: rows[0]?.version ?? null,
          };
        })
      : await withMongo(config, async (client) => {
          const admin = client.db().admin();
          const ping = await admin.command({ ping: 1 });
          const buildInfo = await admin.command({ buildInfo: 1 }).catch(() => ({ version: null }));
          return {
            ok: true,
            engine: 'mongodb',
            connection: detail,
            ping,
            version: buildInfo.version ?? null,
          };
        });
    setDatabaseConnectionTestResult(id, 'ok', null);
    return result;
  } catch (err) {
    setDatabaseConnectionTestResult(id, 'error', (err as Error).message);
    throw err;
  }
}

export async function inspectSavedConnectionSchema(id: string, databaseOverride?: unknown): Promise<unknown> {
  const { config, detail } = getStoredConnection(id);
  const database = databaseOverride !== undefined
    ? ensureManagedIdentifier(databaseOverride, 'database')
    : config.database;

  if (config.engine === 'mysql') {
    return withMySql(config, async (conn) => {
      const [databases] = await conn.query<RowDataPacket[]>(
        `SELECT SCHEMA_NAME AS name
           FROM INFORMATION_SCHEMA.SCHEMATA
          ORDER BY SCHEMA_NAME
          LIMIT ?`,
        [DATABASE_LIMITS.maxSchemaDatabases],
      );
      const [tables] = await conn.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS rowCountEstimate
           FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = ?
          ORDER BY TABLE_NAME
          LIMIT ?`,
        [database, DATABASE_LIMITS.maxSchemaTables],
      );
      const tableNames = tables.map((row) => String(row.name));
      const columnsByTable = new Map<string, unknown[]>();
      const indexesByTable = new Map<string, unknown[]>();

      if (tableNames.length > 0) {
        const placeholders = tableNames.map(() => '?').join(', ');
        const [columns] = await conn.query<RowDataPacket[]>(
          `SELECT TABLE_NAME AS tableName,
                  COLUMN_NAME AS name,
                  DATA_TYPE AS dataType,
                  COLUMN_TYPE AS columnType,
                  IS_NULLABLE AS nullable,
                  COLUMN_DEFAULT AS defaultValue,
                  COLUMN_KEY AS columnKey,
                  EXTRA AS extra,
                  ORDINAL_POSITION AS ordinalPosition
             FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})
            ORDER BY TABLE_NAME, ORDINAL_POSITION`,
          [database, ...tableNames],
        );
        for (const column of columns) {
          const key = String(column.tableName);
          const list = columnsByTable.get(key) ?? [];
          if (list.length < DATABASE_LIMITS.maxSchemaColumnsPerTable) {
            list.push({
              name: column.name,
              dataType: column.dataType,
              columnType: column.columnType,
              nullable: column.nullable === 'YES',
              defaultValue: sanitizeForResponse(column.defaultValue),
              key: column.columnKey || null,
              extra: column.extra || null,
            });
            columnsByTable.set(key, list);
          }
        }

        const [indexes] = await conn.query<RowDataPacket[]>(
          `SELECT TABLE_NAME AS tableName,
                  INDEX_NAME AS indexName,
                  COLUMN_NAME AS columnName,
                  NON_UNIQUE AS nonUnique,
                  INDEX_TYPE AS indexType,
                  SEQ_IN_INDEX AS seqInIndex
             FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})
            ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
          [database, ...tableNames],
        );
        const indexMap = new Map<string, Map<string, { unique: boolean; indexType: string; columns: string[] }>>();
        for (const index of indexes) {
          const table = String(index.tableName);
          const tableMap = indexMap.get(table) ?? new Map();
          const current = tableMap.get(String(index.indexName)) ?? {
            unique: Number(index.nonUnique) === 0,
            indexType: String(index.indexType || ''),
            columns: [],
          };
          current.columns.push(String(index.columnName));
          tableMap.set(String(index.indexName), current);
          indexMap.set(table, tableMap);
        }
        for (const [table, tableMap] of indexMap.entries()) {
          indexesByTable.set(
            table,
            Array.from(tableMap.entries()).map(([indexName, info]) => ({ indexName, ...info })),
          );
        }
      }

      return ensureReadPayloadSize({
        engine: 'mysql',
        connection: detail,
        selectedDatabase: database,
        databases: databases.map((row) => ({ name: row.name })),
        tables: tables.map((table) => ({
          name: table.name,
          type: table.type,
          engine: table.engine,
          rowCountEstimate: table.rowCountEstimate,
          columns: columnsByTable.get(String(table.name)) ?? [],
          indexes: indexesByTable.get(String(table.name)) ?? [],
        })),
      });
    });
  }

  return withMongo(config, async (client) => {
    const dbs = await client.db().admin().listDatabases();
    const db = client.db(database);
    const collectionInfos = await db.listCollections({}, { nameOnly: false }).toArray();
    const collections = [] as unknown[];
    for (const info of collectionInfos.slice(0, DATABASE_LIMITS.maxSchemaCollections)) {
      const collectionName = String(info.name);
      const collection = db.collection(collectionName);
      const docs = await collection
        .find({}, { maxTimeMS: DATABASE_LIMITS.maxQueryTimeMs })
        .limit(DATABASE_LIMITS.maxMongoSampleDocs)
        .toArray();
      const indexes = await collection.indexes().catch(() => []);
      const estimatedDocumentCount = await collection
        .estimatedDocumentCount({ maxTimeMS: DATABASE_LIMITS.maxQueryTimeMs })
        .catch(() => null);
      collections.push({
        name: collectionName,
        type: info.type ?? 'collection',
        options: sanitizeForResponse(info.options ?? {}),
        estimatedDocumentCount,
        indexes: sanitizeForResponse(indexes),
        sampledFields: inferFieldMap(docs),
      });
    }
    return ensureReadPayloadSize({
      engine: 'mongodb',
      connection: detail,
      selectedDatabase: database,
      databases: (dbs.databases || []).slice(0, DATABASE_LIMITS.maxSchemaDatabases).map((item) => ({
        name: item.name,
        sizeOnDisk: item.sizeOnDisk ?? null,
        empty: item.empty ?? null,
      })),
      collections,
    });
  });
}

export async function runSavedConnectionRead(id: string, body: unknown): Promise<unknown> {
  const { config, detail } = getStoredConnection(id);
  const payload = ensurePlainObject(body, 'request body');

  if (config.engine === 'mysql') {
    const sql = normalizeReadSql(payload.sql);
    return withMySql(config, async (conn) => {
      await conn.query('SET SESSION sql_select_limit = ?', [DATABASE_LIMITS.maxReadRows]).catch(() => {});
      await conn.query('SET SESSION max_execution_time = ?', [DATABASE_LIMITS.maxQueryTimeMs]).catch(() => {});
      const [rows, fields] = await conn.query<RowDataPacket[] & ResultSetHeader>(sql);
      const safeRows = Array.isArray(rows)
        ? rows.slice(0, DATABASE_LIMITS.maxReadRows).map((row) => sanitizeForResponse(row))
        : [sanitizeForResponse(rows)];
      return ensureReadPayloadSize({
        engine: 'mysql',
        connection: detail,
        statement: sql,
        fields: (fields as FieldPacket[]).map((field) => ({
          name: field.name,
          columnType: field.columnType,
          columnLength: field.columnLength,
          decimals: field.decimals,
        })),
        rows: safeRows,
        rowCount: safeRows.length,
      });
    });
  }

  const mode = payload.mode === 'aggregate' || payload.mode === 'count' ? payload.mode : 'find';
  const database = payload.database !== undefined
    ? ensureManagedIdentifier(payload.database, 'database')
    : config.database;
  const collectionName = ensureManagedIdentifier(payload.collection, 'collection');

  return withMongo(config, async (client) => {
    const collection = client.db(database).collection(collectionName);

    if (mode === 'count') {
      const filter = ensureOptionalPlainObject(payload.filter, 'filter') ?? {};
      const count = await collection.countDocuments(filter, { maxTimeMS: DATABASE_LIMITS.maxQueryTimeMs });
      return ensureReadPayloadSize({
        engine: 'mongodb',
        connection: detail,
        database,
        collection: collectionName,
        mode,
        count,
      });
    }

    if (mode === 'aggregate') {
      const pipeline = ensureArray<JsonObject>(payload.pipeline, 'pipeline').map((stage, index) => {
        const parsed = ensurePlainObject(stage, `pipeline[${index}]`);
        const keys = Object.keys(parsed);
        if (keys.some((key) => key === '$out' || key === '$merge')) {
          throw new HttpError(400, 'aggregate pipeline may not use $out or $merge.' );
        }
        return parsed;
      });
      if (pipeline.length > DATABASE_LIMITS.maxMongoPipelineStages) {
        throw new HttpError(400, `aggregate pipeline may contain at most ${DATABASE_LIMITS.maxMongoPipelineStages} stages.`);
      }
      const limit = Math.max(1, Math.min(DATABASE_LIMITS.maxReadRows, Number(payload.limit ?? DATABASE_LIMITS.maxReadRows) || DATABASE_LIMITS.maxReadRows));
      const result = await collection
        .aggregate([...pipeline, { $limit: limit }], { maxTimeMS: DATABASE_LIMITS.maxQueryTimeMs })
        .toArray();
      return ensureReadPayloadSize({
        engine: 'mongodb',
        connection: detail,
        database,
        collection: collectionName,
        mode,
        rows: result.map((doc) => sanitizeForResponse(doc)),
        rowCount: result.length,
      });
    }

    const filter = ensureOptionalPlainObject(payload.filter, 'filter') ?? {};
    const projection = ensureOptionalPlainObject(payload.projection, 'projection');
    const sort = ensureSort(payload.sort);
    const limit = Math.max(1, Math.min(DATABASE_LIMITS.maxReadRows, Number(payload.limit ?? DATABASE_LIMITS.maxReadRows) || DATABASE_LIMITS.maxReadRows));
    const docs = await collection
      .find(filter, {
        projection,
        sort,
        limit,
        maxTimeMS: DATABASE_LIMITS.maxQueryTimeMs,
      })
      .limit(limit)
      .toArray();

    return ensureReadPayloadSize({
      engine: 'mongodb',
      connection: detail,
      database,
      collection: collectionName,
      mode: 'find',
      rows: docs.map((doc) => sanitizeForResponse(doc)),
      rowCount: docs.length,
    });
  });
}

function normalizeMySqlGrantPrivileges(value: unknown): string[] {
  const privileges = ensureArray<unknown>(value, 'privileges').map((entry, index) => {
    const privilege = ensureText(entry, `privileges[${index}]`, 64).replace(/\s+/g, ' ').toUpperCase();
    if (!MYSQL_GRANT_PRIVILEGE_RE.test(privilege)) {
      throw new HttpError(400, `privileges[${index}] contains unsupported characters.`);
    }
    if (privilege === 'GRANT OPTION') {
      throw new HttpError(400, 'GRANT OPTION must be requested with withGrantOption instead of privileges[].');
    }
    return privilege;
  });
  if (privileges.length === 0 || privileges.length > 32) {
    throw new HttpError(400, 'privileges must contain between 1 and 32 entries.');
  }
  const unique = Array.from(new Set(privileges));
  if (unique.includes('ALL PRIVILEGES') && unique.length > 1) {
    throw new HttpError(400, 'ALL PRIVILEGES may not be combined with other privileges.');
  }
  return unique;
}

function normalizeMySqlGrant(payload: JsonObject): Required<Omit<MySqlGrantRequest, 'confirmed'>> {
  const database = ensureManagedIdentifierOrWildcard(payload.database, 'database');
  const table = payload.table !== undefined
    ? ensureManagedIdentifierOrWildcard(payload.table, 'table')
    : '*';
  if (database === '*' && table !== '*') {
    throw new HttpError(400, 'table must be "*" when database is "*".');
  }
  return {
    username: ensureMySqlGrantUsername(payload.username),
    host: ensureMySqlGrantHost(payload.host),
    privileges: normalizeMySqlGrantPrivileges(payload.privileges),
    database,
    table,
    withGrantOption: ensureBoolean(payload.withGrantOption, 'withGrantOption', false),
  };
}

function normalizeMongoGrantRoles(value: unknown): MongoGrantRole[] {
  const roles = ensureArray<unknown>(value, 'roles');
  if (roles.length === 0 || roles.length > 64) {
    throw new HttpError(400, 'roles must contain between 1 and 64 entries.');
  }
  return roles.map((entry, index) => {
    if (typeof entry === 'string') {
      const normalized = MONGO_BUILT_IN_ROLE_LOOKUP.get(ensureText(entry, `roles[${index}]`, 128).toLowerCase());
      if (!normalized) {
        throw new HttpError(400, `roles[${index}] must be a built-in MongoDB role string or { role, db } object.`);
      }
      return normalized;
    }
    const role = ensurePlainObject(entry, `roles[${index}]`);
    return {
      role: ensureMongoRoleName(role.role, `roles[${index}].role`),
      db: ensureManagedIdentifier(role.db, `roles[${index}].db`),
    };
  });
}

function normalizeMongoRoleGrant(payload: JsonObject): Required<Omit<MongoRoleGrantRequest, 'confirmed'>> {
  return {
    username: ensureMongoGrantUsername(payload.username),
    authDatabase: ensureManagedIdentifier(payload.authDatabase, 'authDatabase'),
    roles: normalizeMongoGrantRoles(payload.roles),
  };
}

function quotedMySqlGrantScope(request: Required<Omit<MySqlGrantRequest, 'confirmed'>>): string {
  const database = request.database === '*' ? '*' : quotedMySqlIdentifier(request.database);
  const table = request.table === '*' ? '*' : quotedMySqlIdentifier(request.table);
  return `${database}.${table}`;
}

function quotedMySqlAccount(request: Required<Omit<MySqlGrantRequest, 'confirmed'>>): string {
  return `${mysql.escape(request.username)}@${mysql.escape(request.host)}`;
}

function buildMySqlGrantStatement(request: Required<Omit<MySqlGrantRequest, 'confirmed'>>): string {
  return `GRANT ${request.privileges.join(', ')} ON ${quotedMySqlGrantScope(request)} TO ${quotedMySqlAccount(request)}${request.withGrantOption ? ' WITH GRANT OPTION' : ''}`;
}

function mongoRoleSummary(role: MongoGrantRole): string {
  return typeof role === 'string' ? role : `${role.role}@${role.db}`;
}

export function previewGrant(id: string, body: unknown): { summary: string; request: unknown } {
  const { config, detail } = getStoredConnection(id);
  const payload = ensurePlainObject(body, 'request body');

  if (config.engine === 'mysql') {
    const request = normalizeMySqlGrant(payload);
    return {
      summary: `Grant MySQL ${truncateString(request.privileges.join(', '))} on ${request.database}.${request.table} to ${request.username}@${request.host} via ${detail.name}`,
      request,
    };
  }

  const request = normalizeMongoRoleGrant(payload);
  return {
    summary: `Grant MongoDB role(s) ${truncateString(request.roles.map(mongoRoleSummary).join(', '))} to ${request.username} on ${detail.name} (${request.authDatabase})`,
    request: {
      username: request.username,
      authDatabase: request.authDatabase,
      roles: request.roles,
    },
  };
}

export function previewMutation(id: string, body: unknown): { summary: string; request: unknown } {
  const { config, detail } = getStoredConnection(id);
  const payload = ensurePlainObject(body, 'request body');

  if (config.engine === 'mysql') {
    const statement = normalizeMutationSql(payload.statement, SQL_MUTATION_VERBS, 'statement');
    return {
      summary: `Run MySQL mutation on ${detail.name}: ${truncateString(statement)}`,
      request: { statement },
    };
  }

  const operation = normalizeMongoMutation(payload, config.database);
  return {
    summary: `Run MongoDB ${operation.operation} on ${detail.name}.${operation.collection}`,
    request: operation,
  };
}

export function previewMigration(id: string, body: unknown): { summary: string; request: unknown } {
  const { config, detail } = getStoredConnection(id);
  const payload = ensurePlainObject(body, 'request body');

  if (config.engine === 'mysql') {
    const statements = ensureArray<string>(payload.statements, 'statements').map((statement, index) =>
      normalizeMutationSql(statement, SQL_MIGRATION_VERBS, `statements[${index}]`),
    );
    if (statements.length === 0 || statements.length > DATABASE_LIMITS.maxMutationSteps) {
      throw new HttpError(400, `statements must contain between 1 and ${DATABASE_LIMITS.maxMutationSteps} entries.`);
    }
    return {
      summary: `Run ${statements.length} MySQL migration statement(s) on ${detail.name}`,
      request: { statements },
    };
  }

  const steps = normalizeMongoMigrationSteps(payload.steps, config.database);
  return {
    summary: `Run ${steps.length} MongoDB migration step(s) on ${detail.name}`,
    request: { steps },
  };
}

function normalizeMongoMutation(payload: JsonObject, defaultDatabase: string): MongoMutationOperation {
  const operation = ensureText(payload.operation, 'operation', 32) as MongoMutationOperation['operation'];
  const database = payload.database !== undefined ? ensureManagedIdentifier(payload.database, 'database') : defaultDatabase;
  const collection = ensureManagedIdentifier(payload.collection, 'collection');

  switch (operation) {
    case 'insertOne':
      return { operation, database, collection, document: ensurePlainObject(payload.document, 'document') };
    case 'insertMany': {
      const documents = ensureArray<JsonObject>(payload.documents, 'documents').map((doc, index) => ensurePlainObject(doc, `documents[${index}]`));
      if (documents.length === 0 || documents.length > DATABASE_LIMITS.maxInsertManyDocuments) {
        throw new HttpError(400, `documents must contain between 1 and ${DATABASE_LIMITS.maxInsertManyDocuments} entries.`);
      }
      return { operation, database, collection, documents };
    }
    case 'updateOne':
    case 'updateMany':
      return {
        operation,
        database,
        collection,
        filter: ensureOptionalPlainObject(payload.filter, 'filter') ?? {},
        update: ensurePlainObject(payload.update, 'update'),
        upsert: ensureBoolean(payload.upsert, 'upsert', false),
      };
    case 'deleteOne':
    case 'deleteMany':
      return {
        operation,
        database,
        collection,
        filter: ensureOptionalPlainObject(payload.filter, 'filter') ?? {},
      };
    default:
      throw new HttpError(400, 'Unsupported MongoDB mutation operation.' );
  }
}

function normalizeMongoMigrationSteps(value: unknown, defaultDatabase: string): MongoMigrationStep[] {
  const steps = ensureArray<JsonObject>(value, 'steps');
  if (steps.length === 0 || steps.length > DATABASE_LIMITS.maxMutationSteps) {
    throw new HttpError(400, `steps must contain between 1 and ${DATABASE_LIMITS.maxMutationSteps} entries.`);
  }
  return steps.map((step, index) => {
    const payload = ensurePlainObject(step, `steps[${index}]`);
    const operation = ensureText(payload.operation, `steps[${index}].operation`, 32);
    const database = payload.database !== undefined ? ensureManagedIdentifier(payload.database, 'database') : defaultDatabase;
    const collection = payload.collection !== undefined ? ensureManagedIdentifier(payload.collection, 'collection') : undefined;

    switch (operation) {
      case 'createCollection':
      case 'dropCollection':
        if (!collection) throw new HttpError(400, `${operation} requires collection.`);
        return { operation, database, collection };
      case 'renameCollection':
        if (!collection) throw new HttpError(400, 'renameCollection requires collection.' );
        return { operation, database, collection, to: ensureManagedIdentifier(payload.to, 'to') };
      case 'createIndex': {
        if (!collection) throw new HttpError(400, 'createIndex requires collection.' );
        const keys = ensurePlainObject(payload.keys, 'keys') as Record<string, 1 | -1 | 'text' | 'hashed' | '2dsphere'>;
        for (const [key, direction] of Object.entries(keys)) {
          if (!key || key.length > 128) throw new HttpError(400, 'Index key names must be short strings.' );
          if (![1, -1, 'text', 'hashed', '2dsphere'].includes(direction as never)) {
            throw new HttpError(400, 'Unsupported MongoDB index direction.' );
          }
        }
        return { operation, database, collection, keys, options: ensureOptionalPlainObject(payload.options, 'options') };
      }
      case 'dropIndex':
        if (!collection) throw new HttpError(400, 'dropIndex requires collection.' );
        return { operation, database, collection, indexName: ensureIndexName(payload.indexName) };
      case 'insertOne':
      case 'insertMany':
      case 'updateOne':
      case 'updateMany':
      case 'deleteOne':
      case 'deleteMany':
        return normalizeMongoMutation({ ...payload, operation, database, collection }, defaultDatabase) as MongoMigrationStep;
      default:
        throw new HttpError(400, `Unsupported MongoDB migration step "${operation}".`);
    }
  });
}

export async function executeConfirmedGrant(id: string, body: unknown): Promise<unknown> {
  const { config, detail } = getStoredConnection(id);
  const payload = ensurePlainObject(body, 'request body');

  if (config.engine === 'mysql') {
    const request = normalizeMySqlGrant(payload);
    const statement = buildMySqlGrantStatement(request);
    return withMySqlAdmin(config, async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(statement);
      return {
        engine: 'mysql',
        connection: detail,
        grant: {
          username: request.username,
          host: request.host,
          privileges: request.privileges,
          database: request.database,
          table: request.table,
          withGrantOption: request.withGrantOption,
        },
        statement,
        affectedRows: result.affectedRows,
        warningStatus: result.warningStatus,
      };
    });
  }

  const request = normalizeMongoRoleGrant(payload);
  return withMongo(config, async (client) => {
    const result = await client.db(request.authDatabase).command({
      grantRolesToUser: request.username,
      roles: request.roles,
    });
    return {
      engine: 'mongodb',
      connection: detail,
      grant: {
        username: request.username,
        authDatabase: request.authDatabase,
        roles: request.roles,
      },
      ok: result.ok === 1,
      result: sanitizeForResponse(result),
    };
  });
}

export async function executeConfirmedMutation(id: string, body: unknown): Promise<unknown> {
  const { config, detail } = getStoredConnection(id);
  const payload = ensurePlainObject(body, 'request body');

  if (config.engine === 'mysql') {
    const statement = normalizeMutationSql(payload.statement, SQL_MUTATION_VERBS, 'statement');
    return withMySql(config, async (conn) => {
      const [result] = await conn.execute<ResultSetHeader>(statement);
      return {
        engine: 'mysql',
        connection: detail,
        statement,
        affectedRows: result.affectedRows,
        changedRows: result.changedRows,
        insertId: result.insertId,
        warningStatus: result.warningStatus,
      };
    });
  }

  const operation = normalizeMongoMutation(payload, config.database);
  return withMongo(config, async (client) => {
    const collection = client.db(operation.database ?? config.database).collection(operation.collection);
    switch (operation.operation) {
      case 'insertOne': {
        const result = await collection.insertOne(operation.document);
        return { engine: 'mongodb', connection: detail, ...operation, insertedId: sanitizeForResponse(result.insertedId) };
      }
      case 'insertMany': {
        const result = await collection.insertMany(operation.documents);
        return { engine: 'mongodb', connection: detail, ...operation, insertedCount: result.insertedCount };
      }
      case 'updateOne': {
        const result = await collection.updateOne(operation.filter ?? {}, operation.update, { upsert: operation.upsert });
        return { engine: 'mongodb', connection: detail, ...operation, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, upsertedId: sanitizeForResponse(result.upsertedId) };
      }
      case 'updateMany': {
        const result = await collection.updateMany(operation.filter ?? {}, operation.update, { upsert: operation.upsert });
        return { engine: 'mongodb', connection: detail, ...operation, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, upsertedCount: result.upsertedCount };
      }
      case 'deleteOne': {
        const result = await collection.deleteOne(operation.filter ?? {});
        return { engine: 'mongodb', connection: detail, ...operation, deletedCount: result.deletedCount };
      }
      case 'deleteMany': {
        const result = await collection.deleteMany(operation.filter ?? {});
        return { engine: 'mongodb', connection: detail, ...operation, deletedCount: result.deletedCount };
      }
    }
  });
}

export async function executeConfirmedMigration(id: string, body: unknown): Promise<unknown> {
  const { config, detail } = getStoredConnection(id);
  const payload = ensurePlainObject(body, 'request body');

  if (config.engine === 'mysql') {
    const statements = ensureArray<string>(payload.statements, 'statements').map((statement, index) =>
      normalizeMutationSql(statement, SQL_MIGRATION_VERBS, `statements[${index}]`),
    );
    if (statements.length === 0 || statements.length > DATABASE_LIMITS.maxMutationSteps) {
      throw new HttpError(400, `statements must contain between 1 and ${DATABASE_LIMITS.maxMutationSteps} entries.`);
    }
    return withMySql(config, async (conn) => {
      const results: unknown[] = [];
      for (const statement of statements) {
        const [result] = await conn.execute<ResultSetHeader>(statement);
        results.push({
          statement,
          affectedRows: result.affectedRows,
          warningStatus: result.warningStatus,
        });
      }
      return { engine: 'mysql', connection: detail, statements: results, transactional: false };
    });
  }

  const steps = normalizeMongoMigrationSteps(payload.steps, config.database);
  return withMongo(config, async (client) => {
    const results: unknown[] = [];
    for (const step of steps) {
      const db = client.db(step.database ?? config.database);
      switch (step.operation) {
        case 'createCollection':
          await db.createCollection(step.collection);
          results.push({ operation: step.operation, collection: step.collection });
          break;
        case 'dropCollection':
          await db.collection(step.collection).drop().catch((err: { codeName?: string }) => {
            if (err?.codeName !== 'NamespaceNotFound') throw err;
          });
          results.push({ operation: step.operation, collection: step.collection });
          break;
        case 'renameCollection':
          await db.collection(step.collection).rename(step.to, { dropTarget: false });
          results.push({ operation: step.operation, collection: step.collection, to: step.to });
          break;
        case 'createIndex':
          results.push({
            operation: step.operation,
            collection: step.collection,
            indexName: await db.collection(step.collection).createIndex(step.keys, step.options),
          });
          break;
        case 'dropIndex':
          await db.collection(step.collection).dropIndex(step.indexName);
          results.push({ operation: step.operation, collection: step.collection, indexName: step.indexName });
          break;
        case 'insertOne':
        case 'insertMany':
        case 'updateOne':
        case 'updateMany':
        case 'deleteOne':
        case 'deleteMany':
          results.push(await executeMongoStep(db, step));
          break;
      }
    }
    return { engine: 'mongodb', connection: detail, steps: sanitizeForResponse(results) };
  });
}

async function executeMongoStep(db: ReturnType<MongoClient['db']>, step: MongoMigrationStep): Promise<unknown> {
  const collection = db.collection(step.collection);
  switch (step.operation) {
    case 'insertOne': {
      const result = await collection.insertOne(step.document);
      return { operation: step.operation, collection: step.collection, insertedId: sanitizeForResponse(result.insertedId) };
    }
    case 'insertMany': {
      const result = await collection.insertMany(step.documents);
      return { operation: step.operation, collection: step.collection, insertedCount: result.insertedCount };
    }
    case 'updateOne': {
      const result = await collection.updateOne(step.filter ?? {}, step.update, { upsert: step.upsert });
      return { operation: step.operation, collection: step.collection, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
    }
    case 'updateMany': {
      const result = await collection.updateMany(step.filter ?? {}, step.update, { upsert: step.upsert });
      return { operation: step.operation, collection: step.collection, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
    }
    case 'deleteOne': {
      const result = await collection.deleteOne(step.filter ?? {});
      return { operation: step.operation, collection: step.collection, deletedCount: result.deletedCount };
    }
    case 'deleteMany': {
      const result = await collection.deleteMany(step.filter ?? {});
      return { operation: step.operation, collection: step.collection, deletedCount: result.deletedCount };
    }
    default:
      throw new HttpError(500, `Unsupported MongoDB step execution for ${String((step as { operation?: string }).operation)}.`);
  }
}

function serializeMySqlBackupValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return { __type: 'buffer', base64: value.toString('base64') };
  if (value instanceof Date) return { __type: 'date', iso: value.toISOString() };
  if (typeof value === 'bigint') return { __type: 'bigint', value: value.toString() };
  if (Array.isArray(value)) return value.map((entry) => serializeMySqlBackupValue(entry));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, serializeMySqlBackupValue(entry)]));
  }
  return value;
}

function deserializeMySqlBackupValue(value: unknown): unknown {
  if (!isPlainObject(value) || typeof value.__type !== 'string') {
    if (Array.isArray(value)) return value.map((entry) => deserializeMySqlBackupValue(entry));
    if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deserializeMySqlBackupValue(entry)]));
    }
    return value;
  }
  switch (value.__type) {
    case 'buffer':
      return Buffer.from(String(value.base64 ?? ''), 'base64');
    case 'date':
      return new Date(String(value.iso ?? ''));
    case 'bigint':
      return String(value.value ?? '0');
    default:
      return value;
  }
}

async function ensureBackupDirectory(): Promise<void> {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
}

export async function executeBackupJob(connectionId: string, jobId: string, request: BackupRequest): Promise<{ artifactPath: string; artifactFormat: string; artifactSize: number; result: unknown }> {
  const { config, detail } = getStoredConnection(connectionId);
  const database = request.database !== undefined ? ensureManagedIdentifier(request.database, 'database') : config.database;
  await ensureBackupDirectory();
  const artifactPath = path.join(BACKUP_DIR, `${jobId}.json`);

  if (config.engine === 'mysql') {
    const artifact = await withMySql({ ...config, database }, async (conn) => {
      const [tables] = await conn.query<RowDataPacket[]>(
        `SELECT TABLE_NAME AS name, TABLE_ROWS AS rowCountEstimate
           FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME
          LIMIT ?`,
        [database, DATABASE_LIMITS.maxSchemaTables],
      );
      const estimatedRows = tables.reduce((sum, table) => sum + Number(table.rowCountEstimate ?? 0), 0);
      if (estimatedRows > DATABASE_LIMITS.maxBackupEstimatedRows) {
        throw new HttpError(413, 'Built-in MySQL backup is limited to smaller datasets. Reduce the dataset or use an external backup tool.' );
      }
      const backup: MySqlBackupArtifact = {
        version: 1,
        engine: 'mysql',
        format: 'dockyard.mysql.json',
        createdAt: new Date().toISOString(),
        database,
        sourceConnection: { id: detail.id, name: detail.name },
        tables: [],
      };
      let size = 0;
      for (const table of tables) {
        const tableName = String(table.name);
        const [createRows] = await conn.query<RowDataPacket[]>(`SHOW CREATE TABLE ${quotedMySqlIdentifier(tableName)}`);
        const createRow = createRows[0] as Record<string, unknown> | undefined;
        const createStatement = String(createRow?.['Create Table'] ?? '');
        const [rows] = await conn.query<RowDataPacket[]>(`SELECT * FROM ${quotedMySqlIdentifier(tableName)}`);
        const serializedRows = rows.map((row) => serializeMySqlBackupValue(row) as JsonObject);
        size += Buffer.byteLength(JSON.stringify(serializedRows));
        if (size > DATABASE_LIMITS.maxBackupArtifactBytes) {
          throw new HttpError(413, 'Built-in MySQL backup exceeded the server artifact size limit.' );
        }
        backup.tables.push({
          name: tableName,
          createStatement,
          rowCount: serializedRows.length,
          rows: serializedRows,
        });
      }
      return backup;
    });
    const text = JSON.stringify(artifact, null, 2);
    await fs.writeFile(artifactPath, text, 'utf8');
    return {
      artifactPath,
      artifactFormat: artifact.format,
      artifactSize: Buffer.byteLength(text),
      result: {
        engine: 'mysql',
        connection: detail,
        database,
        tables: artifact.tables.map((table) => ({ name: table.name, rowCount: table.rowCount })),
      },
    };
  }

  const artifact = await withMongo(config, async (client) => {
    const db = client.db(database);
    const collectionInfos = await db.listCollections({}, { nameOnly: false }).toArray();
    const backup: MongoBackupArtifact = {
      version: 1,
      engine: 'mongodb',
      format: 'dockyard.mongodb.ejson',
      createdAt: new Date().toISOString(),
      database,
      sourceConnection: { id: detail.id, name: detail.name },
      collections: [],
    };
    let size = 0;
    for (const info of collectionInfos.slice(0, DATABASE_LIMITS.maxSchemaCollections)) {
      const name = String(info.name);
      const collection = db.collection(name);
      const count = await collection.estimatedDocumentCount({ maxTimeMS: DATABASE_LIMITS.maxQueryTimeMs }).catch(() => 0);
      if (count > DATABASE_LIMITS.maxBackupEstimatedRows) {
        throw new HttpError(413, `Built-in MongoDB backup is limited to smaller collections. Collection "${name}" is too large.`);
      }
      const docs = await collection.find({}, { maxTimeMS: DATABASE_LIMITS.maxQueryTimeMs }).toArray();
      const indexes = (await collection.indexes()).map((index) => sanitizeForResponse(index) as JsonObject);
      size += Buffer.byteLength(EJSON.stringify(docs));
      if (size > DATABASE_LIMITS.maxBackupArtifactBytes) {
        throw new HttpError(413, 'Built-in MongoDB backup exceeded the server artifact size limit.' );
      }
      backup.collections.push({ name, indexes, documents: docs });
    }
    return backup;
  });
  const text = EJSON.stringify(artifact, { relaxed: false }, 2);
  await fs.writeFile(artifactPath, text, 'utf8');
  return {
    artifactPath,
    artifactFormat: artifact.format,
    artifactSize: Buffer.byteLength(text),
    result: {
      engine: 'mongodb',
      connection: detail,
      database,
      collections: artifact.collections.map((collection) => ({ name: collection.name, documentCount: collection.documents.length })),
    },
  };
}

async function readJobArtifact(job: DatabaseJobRow): Promise<MySqlBackupArtifact | MongoBackupArtifact> {
  if (!job.artifact_path) throw new HttpError(404, 'Backup artifact is not available for this job.' );
  const text = await fs.readFile(job.artifact_path, 'utf8');
  return job.engine === 'mongodb'
    ? (EJSON.parse(text) as MongoBackupArtifact)
    : (JSON.parse(text) as MySqlBackupArtifact);
}

export async function executeRestoreJob(connectionId: string, request: RestoreRequest): Promise<unknown> {
  const job = getDatabaseJob(ensureJobId(request.jobId));
  if (!job) throw new HttpError(404, 'Backup job not found.' );
  const { config, detail } = getStoredConnection(connectionId);
  const artifact = await readJobArtifact(job);

  if (artifact.engine !== config.engine) {
    throw new HttpError(400, `Backup job ${job.id} is for ${artifact.engine}, but connection ${detail.name} is ${config.engine}.`);
  }

  const targetDatabase = request.targetDatabase !== undefined
    ? ensureManagedIdentifier(request.targetDatabase, 'targetDatabase')
    : artifact.database;

  if (artifact.engine === 'mysql' && config.engine === 'mysql') {
    return withMySqlAdmin(config, async (adminConn) => {
      await adminConn.execute(`CREATE DATABASE IF NOT EXISTS ${quotedMySqlIdentifier(targetDatabase)}`);
      return withMySql({ ...config, database: targetDatabase }, async (conn) => {
        await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
        try {
          for (const table of artifact.tables) {
            await conn.execute(`DROP TABLE IF EXISTS ${quotedMySqlIdentifier(table.name)}`);
          }
          for (const table of artifact.tables) {
            await conn.execute(table.createStatement);
            for (const row of table.rows) {
              const entries = Object.entries(row);
              if (entries.length === 0) continue;
              const columns = entries.map(([key]) => quotedMySqlIdentifier(key)).join(', ');
              const placeholders = entries.map(() => '?').join(', ');
              const values = entries.map(([, value]) => deserializeMySqlBackupValue(value));
              await conn.query(
                `INSERT INTO ${quotedMySqlIdentifier(table.name)} (${columns}) VALUES (${placeholders})`,
                values as any[],
              );
            }
          }
        } finally {
          await conn.execute('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
        }
        return {
          engine: 'mysql',
          connection: detail,
          restoredFromJobId: job.id,
          targetDatabase,
          tables: artifact.tables.map((table) => ({ name: table.name, rowCount: table.rowCount })),
        };
      });
    });
  }

  if (artifact.engine === 'mongodb' && config.engine === 'mongodb') {
    return withMongo(config, async (client) => {
      const db = client.db(targetDatabase);
      for (const collectionData of artifact.collections) {
        await db.collection(collectionData.name).drop().catch((err: { codeName?: string }) => {
          if (err?.codeName !== 'NamespaceNotFound') throw err;
        });
      }
      for (const collectionData of artifact.collections) {
        const collection = db.collection(collectionData.name);
        if (collectionData.documents.length > 0) {
          await collection.insertMany(collectionData.documents as JsonObject[]);
        }
        for (const rawIndex of collectionData.indexes) {
          const index = rawIndex as Record<string, unknown>;
          if (index.name === '_id_') continue;
          const { key, v, ns, background, ...options } = index;
          if (key && isPlainObject(key)) {
            await collection.createIndex(key as Record<string, 1 | -1 | 'text' | 'hashed' | '2dsphere'>, options);
          }
        }
      }
      return {
        engine: 'mongodb',
        connection: detail,
        restoredFromJobId: job.id,
        targetDatabase,
        collections: artifact.collections.map((collection) => ({ name: collection.name, documentCount: collection.documents.length })),
      };
    });
  }

  throw new HttpError(500, 'Unsupported restore request.' );
}

export async function getJobArtifactDownload(jobId: string): Promise<{ row: DatabaseJobRow; contentType: string; fileName: string; body: string }> {
  const row = getDatabaseJob(ensureJobId(jobId));
  if (!row) throw new HttpError(404, 'Database job not found.' );
  if (!row.artifact_path || !row.artifact_format) throw new HttpError(404, 'This job has no downloadable artifact.' );
  const body = await fs.readFile(row.artifact_path, 'utf8');
  const suffix = row.engine === 'mongodb' ? 'ejson' : 'json';
  return {
    row,
    contentType: 'application/json; charset=utf-8',
    fileName: `${row.id}.${suffix}`,
    body,
  };
}

function parseRequestJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toOperationOverview(row: DatabaseOperationRow) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    engine: row.engine,
    category: row.category,
    action: row.action,
    summary: row.summary,
    status: row.status,
    request: parseRequestJson(row.request_json),
    result: parseRequestJson(row.result_json),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toJobOverview(row: DatabaseJobRow) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    engine: row.engine,
    kind: row.kind,
    summary: row.summary,
    status: row.status,
    artifactFormat: row.artifact_format,
    artifactSize: row.artifact_size,
    artifactAvailable: !!row.artifact_path,
    request: parseRequestJson(row.request_json),
    result: parseRequestJson(row.result_json),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function listOperationOverviews(limit = 25): unknown[] {
  return listDatabaseOperations(limit).map(toOperationOverview);
}

export function listOperationHistory(connectionId: string, limit = 10): unknown[] {
  return listDatabaseOperationsForConnection(ensureConnectionId(connectionId), limit).map(toOperationOverview);
}

export function listJobOverviews(limit = 25): unknown[] {
  return listDatabaseJobs(limit).map(toJobOverview);
}

export function getOperationsOverview(): unknown {
  const connections = listConnectionDetails();
  const recentOperations = listOperationOverviews(10);
  const recentJobs = listJobOverviews(10);
  const unhealthyConnections = connections.filter((connection) => connection.lastTestStatus === 'error').length;
  const byEngine = {
    mysql: connections.filter((connection) => connection.engine === 'mysql').length,
    mongodb: connections.filter((connection) => connection.engine === 'mongodb').length,
  };

  return {
    masterKeyConfigured: !!readMasterSecret(),
    connections: {
      total: connections.length,
      unhealthy: unhealthyConnections,
      byEngine,
      items: connections,
    },
    recentOperations,
    recentJobs,
    limits: DATABASE_LIMITS,
  };
}

export function serializeConnectionForStorage(config: StoredConnectionConfig): { encryptedConfig: string; summaryJson: string } {
  return {
    encryptedConfig: encryptConfig(config),
    summaryJson: JSON.stringify(buildSummary(config)),
  };
}
