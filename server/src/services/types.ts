// ── Container types ────────────────────────────────────────

export interface ContainerView {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  ports: Array<{ privatePort: number; publicPort?: number; type: string }>;
  sizeRw?: number;
  sizeRootFs?: number;
  presetId?: string;
  projectId?: string;
  system?: boolean;
  protected?: boolean;
  description?: string;
}

export interface LaunchInput {
  presetId?: string;
  image?: string;
  name?: string;
  description?: string;
  protected?: boolean;
  projectId?: string;
  command?: string[];
  ports?: Array<{ container: string; host: number }>;
  env?: Array<{ key: string; value: string }>;
  volumes?: string[];
  autoStart?: boolean;
  assistantManaged?: boolean;
}

export interface EnvUpdateInput {
  env?: Array<{ key: string; value: string }>;
  persist?: boolean;
  description?: string;
  protected?: boolean;
  projectId?: string | null;
}

export interface ExecInput {
  command: string[];
  workingDir?: string;
  background?: boolean;
  timeoutSeconds?: number;
}

export interface ExecResult {
  command: string[];
  workingDir: string | null;
  exitCode: number | null;
  output: string;
  truncated: boolean;
}

export interface BackgroundExecResult {
  execId: string;
  command: string[];
  workingDir: string | null;
  background: true;
}

export interface ProbeResult {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  truncated: boolean;
}

export interface FileInfo {
  type: 'directory' | 'file';
  name: string;
  size: number;
  mtime: number;
}

export interface WriteFileInput {
  path: string;
  content: string;
}

export interface ReplaceInput {
  path: string;
  search: string;
  replace: string;
}

export interface ReplaceResult {
  replacements: number;
  content: string;
}

export interface CopyToContainerSource {
  /** Source type: "container" or "bucket". */
  type: "container" | "bucket";
  /** For type=container: the source container id. */
  containerId?: string;
  /** Absolute path inside the source container (file or directory). */
  path?: string;
  /** For type=bucket: the bucket name. */
  bucket?: string;
  /** For type=bucket: the object key. */
  key?: string;
}

export interface CopyToContainerInput {
  source: CopyToContainerSource;
  /** Destination container id. */
  destId: string;
  /** Destination path inside the dest container.  For a single file copy this is
   *  the file path; for a directory it's the target directory. */
  destPath: string;
}

// ── Bucket types ───────────────────────────────────────────

export interface BucketView {
  name: string | undefined;
  creationDate: Date | undefined;
  size: number;
  objectCount: number;
  protected: boolean;
  projectId: string | null;
}

export interface ObjectList {
  prefixes: Array<string | undefined>;
  objects: Array<{
    key: string | undefined;
    size: number;
    lastModified: Date | undefined;
  }>;
}

export interface WriteObjectInput {
  key: string;
  content: string;
  contentType?: string;
}

// ── Gateway types ──────────────────────────────────────────

export interface CreateRouteInput {
  name: string;
  displayName?: string;
  targetType: string;
  targetId: string;
  targetPort?: number;
  method?: string;
  pathPattern?: string;
  projectId?: string;
  domain?: string;
}

export interface UpdateRouteInput {
  displayName?: string;
  targetPort?: number;
  method?: string;
  pathPattern?: string | null;
  domain?: string | null;
}

// ── Project types ──────────────────────────────────────────

export interface CreateProjectInput {
  name: string;
  description?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
}

export interface ProjectManifestResource {
  id: string;
  image?: string;
  ports?: Array<{ container: string; host: number | null }>;
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

// ── Lambda types ───────────────────────────────────────────

export interface CreateFunctionInput {
  name: string;
  runtime?: string;
  code?: string;
  packages?: string;
  entryPoint?: string;
  files?: Array<{ path: string; content: string }>;
  description?: string;
  projectId?: string;
}

export interface UpdateFunctionInput {
  name?: string;
  runtime?: string;
  code?: string;
  packages?: string;
  entryPoint?: string;
  files?: Array<{ path: string; content: string }>;
  description?: string | null;
  projectId?: string | null;
}
