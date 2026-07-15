import type { Container, Preset, UsageSnapshot } from './types';

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
