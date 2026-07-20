export interface PresetPort {
  container: string;
  host: number;
  label?: string;
}

export interface PresetEnv {
  key: string;
  value: string;
  required?: boolean;
  description?: string;
}

export interface DiskImpact {
  download: number;
  onDisk: number;
}

export interface Preset {
  id: string;
  name: string;
  category: 'Web' | 'Database' | 'Cache' | 'Runtime' | 'DevOps' | 'OS';
  image: string;
  description: string;
  icon: string;
  ports: PresetPort[];
  env: PresetEnv[];
  volumes?: string[];
  diskImpact?: DiskImpact;
  interactive?: boolean;
}

export interface ContainerPort {
  privatePort: number;
  publicPort?: number;
  type: string;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  ports: ContainerPort[];
  sizeRw: number;
  sizeRootFs: number;
  presetId?: string;
  system?: boolean;
}

export interface HostDisk {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface DockerUsageCategory {
  size: number;
  reclaimable: number;
  count: number;
}

export interface DockerUsage {
  images: DockerUsageCategory;
  containers: DockerUsageCategory;
  volumes: DockerUsageCategory;
  buildCache: DockerUsageCategory;
  totalSize: number;
  totalReclaimable: number;
}

export interface VolumeMount {
  source: string;
  destination: string;
  mode: string;
  type: string;
}

export interface ContainerDetail {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  ports: ContainerPort[];
  env: string[];
  volumes: VolumeMount[];
  restartPolicy: string;
  labels: Record<string, string>;
  sizeRw: number;
  sizeRootFs: number;
}

export interface LambdaFile {
  path: string;
  content: string;
}

export interface LambdaFunction {
  id: string;
  name: string;
  runtime: string;
  code: string;
  packages: string;
  entryPoint: string;
  files: LambdaFile[];
  createdAt: string;
  updatedAt: string;
}

export interface LambdaRuntime {
  id: string;
  name: string;
  image: string;
  icon: string;
}

export interface LambdaResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  runtime: string;
  timestamp: string;
  error?: string;
}

export interface UsageSnapshot {
  timestamp: string;
  host: HostDisk | null;
  docker: DockerUsage | null;
  error?: string;
}

export interface Bucket {
  name: string;
  creationDate: string;
  size?: number;
  objectCount?: number;
}

export interface BucketObject {
  key: string;
  size: number;
  lastModified: string;
}

export interface BucketListing {
  prefixes: string[];
  objects: BucketObject[];
}

export interface GatewayRoute {
  id: string;
  name: string;
  displayName: string | null;
  targetType: 'bucket' | 'container' | 'lambda';
  targetId: string;
  targetPort: number | null;
  method: string | null;
  pathPattern: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayTrafficRouteSummary {
  gatewayName: string;
  routeId: string | null;
  targetType: GatewayRoute['targetType'] | null;
  routeMethod: string | null;
  routePathPattern: string | null;
  requestCount: number;
  successfulRequests: number;
  clientErrorRequests: number;
  serverErrorRequests: number;
  avgDurationMs: number;
  maxDurationMs: number;
  totalRequestBytes: number;
  totalResponseBytes: number;
  lastSeenAt: string;
  errorCounts: Record<string, number>;
}

export interface GatewayTrafficSummary {
  windowHours: number;
  totalRequests: number;
  routes: GatewayTrafficRouteSummary[];
}

export interface GatewayTrafficRequest {
  id: number;
  occurredAt: string;
  gatewayName: string;
  routeId: string | null;
  targetType: GatewayRoute['targetType'] | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  errorClassification: string | null;
}

export interface GatewayTrafficRequests {
  totalMatched: number;
  requests: GatewayTrafficRequest[];
}

export interface GatewayTrafficHour {
  start: string;
  requestCount: number;
  successfulRequests: number;
  clientErrorRequests: number;
  serverErrorRequests: number;
}

export interface GatewayTrafficTimeseries {
  windowHours: number;
  since: string;
  until: string;
  buckets: GatewayTrafficHour[];
}

export interface DockerImage {
  id: string;
  tags: string[];
  size: number;
  created: number;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: string;
  size: number;
  refCount: number;
}

export type DatabaseEngine = 'mysql' | 'mongodb';

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

export interface DatabaseLimits {
  maxReadRows: number;
  maxReadStringChars: number;
  maxReadJsonBytes: number;
  maxReadArrayItems: number;
  maxReadObjectKeys: number;
  maxSchemaDatabases: number;
  maxSchemaTables: number;
  maxSchemaCollections: number;
  maxSchemaColumnsPerTable: number;
  maxSchemaFieldPathsPerCollection: number;
  maxMongoSampleDocs: number;
  maxMongoPipelineStages: number;
  maxMutationSteps: number;
  maxInsertManyDocuments: number;
  maxBackupArtifactBytes: number;
  maxBackupEstimatedRows: number;
  maxQueryPayloadBytes: number;
  maxQueryTimeMs: number;
}

export interface DatabaseOperationOverview {
  id: string;
  connectionId: string;
  engine: DatabaseEngine;
  category: string;
  action: string;
  summary: string;
  status: string;
  request: unknown;
  result: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DatabaseJobOverview {
  id: string;
  connectionId: string;
  engine: DatabaseEngine;
  kind: string;
  summary: string;
  status: string;
  artifactFormat: string | null;
  artifactSize: number | null;
  artifactAvailable: boolean;
  request: unknown;
  result: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DatabaseOverview {
  masterKeyConfigured: boolean;
  connections: {
    total: number;
    unhealthy: number;
    byEngine: Record<DatabaseEngine, number>;
    items: DatabaseConnectionDetail[];
  };
  recentOperations: DatabaseOperationOverview[];
  recentJobs: DatabaseJobOverview[];
  limits: DatabaseLimits;
}

export interface DatabaseConfirmationPreview {
  requiresConfirmation: true;
  category: 'mutation' | 'migration' | 'backup' | 'restore';
  summary: string;
  request: unknown;
}

export interface AssistantPendingAction {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AssistantResolvedResult {
  toolUseId: string;
  ok: boolean;
  content: unknown;
}

export interface AssistantLogEntry {
  kind: 'user' | 'assistant' | 'action' | 'error';
  text: string;
  /** Api response from a tool execution, shown when the user expands an action entry. */
  result?: unknown;
}

/** Everything needed to resume an Ask Dockyard conversation exactly where it
 *  left off. Opaque to the server — it just stores/returns this verbatim. */
export interface AssistantSessionState {
  messages: unknown[];
  log: AssistantLogEntry[];
  pending: AssistantPendingAction[];
  resolved: AssistantResolvedResult[];
}

export interface AssistantSessionSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantSession extends AssistantSessionSummary {
  state: AssistantSessionState;
}

export interface AssistantTurn {
  messages: unknown[];
  pending: AssistantPendingAction[];
  autoResolved: AssistantResolvedResult[];
  done: boolean;
  text: string;
}

export interface BuildCacheEntry {
  id: string;
  type: string;
  description: string;
  size: number;
  created: string;
  inUse: boolean;
  shared: boolean;
}

export interface AssistantIssue {
  id: string;
  summary: string;
  category: string;
  details: unknown;
  createdAt: string;
}
