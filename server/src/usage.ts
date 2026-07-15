import { statfs } from 'node:fs/promises';
import { docker } from './docker.js';

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

/** Host filesystem usage for the volume backing Docker's data root. */
async function readHostDisk(path: string): Promise<HostDisk> {
  const s = await statfs(path);
  // bavail = blocks available to unprivileged users; matches what `df` reports.
  const totalBytes = s.blocks * s.bsize;
  const freeBytes = s.bavail * s.bsize;
  const usedBytes = totalBytes - freeBytes;
  return {
    path,
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
  };
}

interface DfEntry {
  Size?: number;
  Reclaimable?: number;
}

function summarize(entries: unknown, sizeKey: 'Size' | 'SizeRw' = 'Size'): DockerUsageCategory {
  const list = Array.isArray(entries) ? (entries as Record<string, number>[]) : [];
  let size = 0;
  for (const e of list) size += Number(e[sizeKey] ?? e.Size ?? 0) || 0;
  return { size, reclaimable: 0, count: list.length };
}

/** Docker's own accounting: images / containers / volumes / build cache. */
async function readDockerUsage(): Promise<DockerUsage> {
  // dockerode exposes GET /system/df as df(); returns the parsed JSON body.
  const df = (await (docker as unknown as { df: () => Promise<Record<string, unknown>> }).df()) ?? {};

  const images = summarize(df.Images);
  const containers = summarize(df.Containers, 'SizeRw');
  const volumes = summarizeVolumes(df.Volumes);
  const buildCache = summarizeBuildCache(df.BuildCache);

  // Docker reports LayersSize as the deduplicated on-disk image size.
  const layersSize = Number((df.LayersSize as number) ?? images.size) || images.size;
  images.size = layersSize;

  const totalSize = images.size + containers.size + volumes.size + buildCache.size;
  const totalReclaimable =
    images.reclaimable + containers.reclaimable + volumes.reclaimable + buildCache.reclaimable;

  return { images, containers, volumes, buildCache, totalSize, totalReclaimable };
}

function summarizeVolumes(entries: unknown): DockerUsageCategory {
  const list = Array.isArray(entries) ? (entries as Record<string, any>[]) : [];
  let size = 0;
  for (const v of list) size += Number(v?.UsageData?.Size ?? 0) || 0;
  return { size: size < 0 ? 0 : size, reclaimable: 0, count: list.length };
}

function summarizeBuildCache(entries: unknown): DockerUsageCategory {
  const list = Array.isArray(entries) ? (entries as DfEntry[]) : [];
  let size = 0;
  let reclaimable = 0;
  for (const e of list) {
    size += Number(e.Size ?? 0) || 0;
    reclaimable += Number(e.Reclaimable ?? 0) || 0;
  }
  return { size, reclaimable, count: list.length };
}

export async function getUsageSnapshot(): Promise<UsageSnapshot> {
  const hostPath = process.env.HOST_DISK_PATH || '/';
  const snapshot: UsageSnapshot = {
    timestamp: new Date().toISOString(),
    host: null,
    docker: null,
  };
  try {
    snapshot.host = await readHostDisk(hostPath);
  } catch (err) {
    snapshot.error = `host: ${(err as Error).message}`;
  }
  try {
    snapshot.docker = await readDockerUsage();
  } catch (err) {
    snapshot.error = [snapshot.error, `docker: ${(err as Error).message}`]
      .filter(Boolean)
      .join('; ');
  }
  return snapshot;
}
