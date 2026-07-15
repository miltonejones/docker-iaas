import type { Container, ContainerDetail, LambdaFunction, LambdaResult, LambdaRuntime, Preset, UsageSnapshot } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export interface LaunchRequest {
  presetId?: string;
  image?: string;
  name?: string;
  ports?: { container: string; host: number }[];
  env?: { key: string; value: string }[];
  volumes?: string[];
  autoStart?: boolean;
}

export const api = {
  presets: () => fetch('/api/system/presets').then((r) => json<Preset[]>(r)),

  usage: () => fetch('/api/system/usage').then((r) => json<UsageSnapshot>(r)),

  containers: () => fetch('/api/containers').then((r) => json<Container[]>(r)),

  launch: (body: LaunchRequest) =>
    fetch('/api/containers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ id: string }>(r)),

  action: (id: string, action: 'start' | 'stop' | 'restart') =>
    fetch(`/api/containers/${id}/${action}`, { method: 'POST' }).then((r) =>
      json<{ ok: true }>(r),
    ),

  remove: (id: string, force = false) =>
    fetch(`/api/containers/${id}?force=${force}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: true }>(r),
    ),

  logs: (id: string) => fetch(`/api/containers/${id}/logs`).then((r) => r.text()),

  inspect: (id: string) =>
    fetch(`/api/containers/${id}/inspect`).then((r) => json<ContainerDetail>(r)),

  usedPorts: () =>
    fetch('/api/system/used-ports').then((r) => json<{ ports: number[] }>(r)),

  lambdaRuntimes: () =>
    fetch('/api/lambda/runtimes').then((r) => json<LambdaRuntime[]>(r)),

  lambdaRun: (runtime: string, code: string, packages?: string) =>
    fetch('/api/lambda/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtime, code, packages }),
    }).then((r) => json<LambdaResult>(r)),

  lambdaHistory: () =>
    fetch('/api/lambda/history').then((r) => json<LambdaResult[]>(r)),

  lambdaListFunctions: () =>
    fetch('/api/lambda/functions').then((r) => json<LambdaFunction[]>(r)),

  lambdaCreateFunction: (name: string, runtime: string, code: string, packages?: string) =>
    fetch('/api/lambda/functions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, runtime, code, packages }),
    }).then((r) => json<LambdaFunction>(r)),

  lambdaUpdateFunction: (
    id: string,
    fields: { name?: string; runtime?: string; code?: string; packages?: string },
  ) =>
    fetch(`/api/lambda/functions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then((r) => json<LambdaFunction>(r)),

  lambdaDeleteFunction: (id: string) =>
    fetch(`/api/lambda/functions/${id}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: true }>(r),
    ),

  prune: () =>
    fetch('/api/images/prune', { method: 'POST' }).then((r) =>
      json<{ ok: true; reclaimedBytes: number }>(r),
    ),
};

/** Subscribe to the live usage stream. Returns an unsubscribe function. */
export function subscribeUsage(onSnapshot: (s: UsageSnapshot) => void): () => void {
  const source = new EventSource('/api/system/usage/stream');
  source.onmessage = (e) => {
    try {
      onSnapshot(JSON.parse(e.data) as UsageSnapshot);
    } catch {
      /* ignore malformed frame */
    }
  };
  return () => source.close();
}
