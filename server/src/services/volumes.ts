import { docker } from '../docker.js';
import { HttpError } from './HttpError.js';

export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const SYSTEM_LABEL_KEY = 'iaas.system';

// Volumes matching this name are system-managed and must not be deleted.
export const SYSTEM_VOLUME_NAMES = new Set(['iaas-minio-data']);

/** Returns true if the volume is system-managed (label or known system name). */
export function isSystemVolume(name: string, labels?: Record<string, string>): boolean {
  if (SYSTEM_VOLUME_NAMES.has(name)) return true;
  if (labels && labels[SYSTEM_LABEL_KEY]) return true;
  return false;
}

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: string;
  labels: Record<string, string>;
  size: number | null; // null when unknown (-1 from engine)
  refCount: number;
  system: boolean;
  usedBy: Array<{ containerId: string; containerName: string; destination: string; rw: boolean }>;
}

/** Fetch all running/exited containers once and derive per-volume usedBy lists. */
export async function buildUsedByMap(): Promise<Map<string, VolumeInfo['usedBy']>> {
  const map = new Map<string, VolumeInfo['usedBy']>();
  try {
    const containers = await docker.listContainers({ all: true });
    for (const c of containers) {
      for (const m of c.Mounts || []) {
        if (m.Type === 'volume' && m.Name) {
          const entry = { containerId: c.Id, containerName: (c.Names?.[0] || c.Id).replace(/^\//, ''), destination: m.Destination, rw: m.RW ?? false };
          const list = map.get(m.Name);
          if (list) list.push(entry);
          else map.set(m.Name, [entry]);
        }
      }
    }
  } catch { /* Docker engine may be down */ }
  return map;
}

/** Fetch df for volume sizes. */
async function fetchDf(): Promise<Map<string, { size: number | null; refCount: number }>> {
  const map = new Map<string, { size: number | null; refCount: number }>();
  try {
    const df = await docker.df();
    for (const v of (df as any).Volumes || []) {
      const size = v.UsageData?.Size;
      map.set(v.Name, {
        size: (size == null || size === -1) ? null : size,
        refCount: v.UsageData?.RefCount || 0,
      });
    }
  } catch { /* engine may be down */ }
  return map;
}

export async function list(): Promise<VolumeInfo[]> {
  const volumes: any[] = await new Promise((resolve, reject) => {
    (docker as any).modem.dial(
      { method: 'GET', path: '/volumes', statusCodes: { 200: true } },
      (err: unknown, result: any) => (err ? reject(err) : resolve(result?.Volumes || [])),
    );
  });

  const [usedByMap, dfMap] = await Promise.all([buildUsedByMap(), fetchDf()]);

  return volumes.map((v: any) => {
    const name = v.Name || '';
    const df = dfMap.get(name);
    const labels: Record<string, string> = {};
    if (v.Labels) {
      for (const [k, val] of Object.entries(v.Labels)) labels[k] = val as string;
    }
    const system = isSystemVolume(name, labels);
    return {
      name,
      driver: v.Driver || '',
      mountpoint: v.Mountpoint || '',
      createdAt: v.CreatedAt || '',
      labels,
      size: df?.size ?? null,
      refCount: df?.refCount ?? 0,
      system,
      usedBy: usedByMap.get(name) || [],
    };
  });
}

export async function inspect(name: string): Promise<VolumeInfo> {
  let raw: any;
  try {
    raw = await new Promise((resolve, reject) => {
      (docker as any).modem.dial(
        { method: 'GET', path: `/volumes/${encodeURIComponent(name)}`, statusCodes: { 200: true } },
        (err: unknown, result: any) => (err ? reject(err) : resolve(result)),
      );
    });
  } catch (err: any) {
    if (err.statusCode === 404) throw new HttpError(404, `Volume "${name}" not found.`);
    throw err;
  }

  const [usedByMap, dfMap] = await Promise.all([buildUsedByMap(), fetchDf()]);
  const df = dfMap.get(name);
  const labels: Record<string, string> = {};
  if (raw.Labels) {
    for (const [k, val] of Object.entries(raw.Labels)) labels[k] = val as string;
  }
  const system = isSystemVolume(raw.Name || name, labels);

  return {
    name: raw.Name || name,
    driver: raw.Driver || '',
    mountpoint: raw.Mountpoint || '',
    createdAt: raw.CreatedAt || '',
    labels,
    size: df?.size ?? null,
    refCount: df?.refCount ?? 0,
    system,
    usedBy: usedByMap.get(name) || [],
  };
}

export async function create(input: { name: string; driver?: string; labels?: Record<string, string> }): Promise<VolumeInfo> {
  if (!NAME_RE.test(input.name)) {
    throw new HttpError(400, 'Volume name must match /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.');
  }

  try {
    await docker.createVolume({
      Name: input.name,
      Driver: input.driver || 'local',
      Labels: input.labels || {},
    });
  } catch (err: any) {
    if (err.statusCode === 409) throw new HttpError(409, `Volume "${input.name}" already exists.`);
    throw new HttpError(500, err.message || 'Failed to create volume.');
  }

  return inspect(input.name);
}

export async function remove(name: string, force = false): Promise<void> {
  const info = await inspect(name);

  if (info.system) {
    throw new HttpError(403, 'System volumes are managed by Dockyard.');
  }

  try {
    const vol = docker.getVolume(name);
    await vol.remove({ force });
  } catch (err: any) {
    if (err.statusCode === 409) {
      const usedBy = info.usedBy;
      const names = usedBy.map((u) => `"${u.containerName}"`).join(', ');
      throw new HttpError(409, `Volume is in use by: ${names}.`);
    }
    if (err.statusCode === 404) throw new HttpError(404, `Volume "${name}" not found.`);
    throw new HttpError(500, err.message || 'Failed to remove volume.');
  }
}

export async function prune(): Promise<{ volumesDeleted: string[]; spaceReclaimed: number }> {
  const result: any = await docker.pruneVolumes();
  const deleted: string[] = (result.VolumesDeleted || []).map((v: any) => v?.Name || '');
  return {
    volumesDeleted: deleted,
    spaceReclaimed: result.SpaceReclaimed || 0,
  };
}
