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
  targetType: 'bucket' | 'container' | 'lambda';
  targetId: string;
  targetPort: number | null;
  method: string | null;
  pathPattern: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface BuildCacheEntry {
  id: string;
  type: string;
  description: string;
  size: number;
  created: string;
  inUse: boolean;
  shared: boolean;
}
