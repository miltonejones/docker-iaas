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
  approxSize?: string;
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

export interface UsageSnapshot {
  timestamp: string;
  host: HostDisk | null;
  docker: DockerUsage | null;
  error?: string;
}
