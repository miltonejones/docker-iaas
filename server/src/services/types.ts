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
}

export interface UpdateRouteInput {
  displayName?: string;
  method?: string;
  pathPattern?: string | null;
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
