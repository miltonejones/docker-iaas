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
  projectId?: string;
  system?: boolean;
  protected?: boolean;
  description?: string;
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
  description?: string;
  protected?: boolean;
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
  projectId: string | null;
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
  protected?: boolean;
  projectId?: string | null;
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
  projectId: string | null;
  domain: string | null;
  domainVerified: boolean;
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

export interface VolumeUsedBy {
  containerId: string;
  containerName: string;
  destination: string;
  rw: boolean;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: string;
  labels: Record<string, string>;
  size: number | null;
  refCount: number;
  system: boolean;
  usedBy: VolumeUsedBy[];
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
  projectId: string | null;
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
  /** Which user-defined assistant produced this entry, so the avatar reflects
   *  the assistant that was active at the time rather than the currently
   *  selected one (which may have changed since). null = the default assistant. */
  assistantId?: string | null;
}

/** Cumulative Anthropic token usage for a session, accumulated client-side
 *  from `usage` SSE events (one per Anthropic API round). */
export interface AssistantUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** Everything needed to resume an Ask Dockyard conversation exactly where it
 *  left off. Opaque to the server — it just stores/returns this verbatim. */
export interface AssistantSessionState {
  messages: unknown[];
  log: AssistantLogEntry[];
  pending: AssistantPendingAction[];
  resolved: AssistantResolvedResult[];
  assistantId?: string | null;
  usage?: AssistantUsage;
}

export interface AssistantSessionSummary {
  id: string;
  name: string;
  assistantId?: string | null;
  createdAt: string;
  updatedAt: string;
  running?: boolean;
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
  status: string;
  resolution: string | null;
  resolvedBy: string | null;
  engine: string | null;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail extends Project {
  summary: {
    containers: number;
    functions: number;
    buckets: number;
    routes: number;
    databases: number;
  };
}

export interface ProjectManifestResource {
  id: string;
  image?: string;
  ports?: { container: string; host: number | null }[];
  env?: Record<string, string>;
  volumes?: string[];
  description?: string;
  targetType?: 'container' | 'bucket' | 'lambda';
  targetRef?: string;
  targetPort?: number | null;
  method?: string | null;
  pathPattern?: string | null;
  domain?: string | null;
  runtime?: string;
  engine?: string;
}

export type ManifestSection = 'containers' | 'routes' | 'functions' | 'buckets' | 'databases';

export interface ProjectManifest {
  version: number;
  capturedAt: string;
  containers: Record<string, ProjectManifestResource>;
  routes: Record<string, ProjectManifestResource>;
  functions: Record<string, ProjectManifestResource>;
  buckets: Record<string, ProjectManifestResource>;
  databases: Record<string, ProjectManifestResource>;
}

export interface ManifestDrift {
  synced: string[];
  missing: Array<{ ref: string; kind: ManifestSection }>;
  changed: Array<{ ref: string; kind: ManifestSection; diff: Record<string, unknown> }>;
  orphaned: Array<{ ref: string; kind: ManifestSection; id: string }>;
}

export interface UserAssistant {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  toolList: string[];
  voice: string;
  icon: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
