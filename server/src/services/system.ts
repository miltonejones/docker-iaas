import { pingDocker, docker } from '../docker.js';
import { PRESETS } from '../presets.js';
import { getUsageSnapshot } from '../usage.js';
import { listAuditLogs } from '../db/audit.js';

export async function ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
  return pingDocker();
}

export function presets(): unknown {
  return PRESETS;
}

export async function usage(): Promise<unknown> {
  return getUsageSnapshot();
}

export async function buildCache(): Promise<unknown> {
  const data: any = await new Promise((resolve, reject) => {
    (docker as any).modem.dial(
      { method: 'GET', path: '/system/df', statusCodes: { 200: true } },
      (err: unknown, result: any) => (err ? reject(err) : resolve(result)),
    );
  });
  return (data?.BuildCache || []).map((e: any) => ({
    id: e.ID?.slice(0, 12) || '',
    type: e.Type || '',
    description: e.Description || '',
    size: e.Size || 0,
    created: e.CreatedAt || '',
    inUse: e.InUse || false,
    shared: e.Shared || false,
  }));
}

export async function pruneBuildCache(): Promise<{
  ok: boolean;
  cachesDeleted?: number;
  spaceReclaimed?: number;
}> {
  const data: any = await new Promise((resolve, reject) => {
    (docker as any).modem.dial(
      { method: 'POST', path: '/build/prune?all=true', statusCodes: { 200: true } },
      (err: unknown, result: any) => (err ? reject(err) : resolve(result)),
    );
  });
  return {
    ok: true,
    cachesDeleted: data?.CachesDeleted?.length || 0,
    spaceReclaimed: data?.SpaceReclaimed || 0,
  };
}

export async function usedPorts(): Promise<{ ports: number[] }> {
  const list = await docker.listContainers({ all: true });
  const used = new Set<number>();
  for (const c of list) {
    for (const p of c.Ports || []) {
      if (p.PublicPort) used.add(p.PublicPort);
    }
  }
  return { ports: Array.from(used).sort((a, b) => a - b) };
}

export function audit(limit?: number): unknown[] {
  return listAuditLogs(limit ?? 50);
}
