import type {
  AssistantSession,
  AssistantSessionState,
  AssistantSessionSummary,
  AssistantTurn,
  Bucket,
  BucketListing,
  BuildCacheEntry,
  Container,
  ContainerDetail,
  DatabaseConfirmationPreview,
  DatabaseConnectionDetail,
  DatabaseJobOverview,
  DatabaseOperationOverview,
  DatabaseOverview,
  DockerImage,
  DockerVolume,
  GatewayRoute,
  GatewayTrafficRequests,
  GatewayTrafficSummary,
  LambdaFile,
  LambdaFunction,
  LambdaResult,
  LambdaRuntime,
  Preset,
  UsageSnapshot,
} from './types';

/** Parse a Server-Sent Events stream from a fetch Response into an async
 *  generator of JSON objects — one yield per `data:` line. */
async function* parseSSE(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error('No response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            yield JSON.parse(line.slice(6));
          } catch {
            // skip malformed JSON lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

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
  assistantManaged?: boolean;
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

  /** Write a text file into a running container (used to host a site on an OS
   *  container, e.g. place index.html into an nginx container's served dir). */
  containerWriteFile: (id: string, path: string, content: string) =>
    fetch(`/api/containers/${id}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    }).then((r) => json<{ ok: true; path: string }>(r)),

  containerExec: (id: string, command: string[], workingDir?: string) =>
    fetch(`/api/containers/${id}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, workingDir }),
    }).then((r) =>
      json<{ command: string[]; workingDir: string | null; exitCode: number | null; output: string; truncated: boolean }>(r),
    ),

  hostFileToBucket: (sourcePath: string, bucket: string, key: string, contentType?: string) =>
    fetch('/api/host-files/to-bucket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath, bucket, key, contentType }),
    }).then((r) => json<{ bucket: string; key: string; size: number }>(r)),

  hostFileToContainer: (sourcePath: string, id: string, path: string) =>
    fetch('/api/host-files/to-container', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath, id, path }),
    }).then((r) => json<{ ok: true; id: string; path: string; size: number }>(r)),

  hostBuildRun: (preset: string, id: string, path: string) =>
    fetch('/api/host-builds/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset, id, path }),
    }).then((r) => json<{ ok: true; preset: string; id: string; path: string; size: number }>(r)),

  githubPullToBucket: (owner: string, repo: string, bucket: string, ref?: string, prefix?: string) =>
    fetch('/api/github/pull-to-bucket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, repo, bucket, ref, prefix }),
    }).then((r) => json<{ owner: string; repo: string; ref: string | null; bucket: string; prefix: string | null; filesWritten: number }>(r)),

  githubPullToContainer: (owner: string, repo: string, id: string, path: string, ref?: string) =>
    fetch('/api/github/pull-to-container', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, repo, id, path, ref }),
    }).then((r) => json<{ owner: string; repo: string; ref: string | null; id: string; path: string; filesWritten: number }>(r)),

  githubCommitAndPush: (
    owner: string,
    repo: string,
    message: string,
    files: { path: string; content: string }[],
    branch?: string,
  ) =>
    fetch('/api/github/commit-and-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, repo, message, files, branch }),
    }).then((r) =>
      json<{ owner: string; repo: string; committed: boolean; branch?: string; sha?: string; filesChanged?: string[]; reason?: string }>(r),
    ),

  usedPorts: () =>
    fetch('/api/system/used-ports').then((r) => json<{ ports: number[] }>(r)),

  lambdaRuntimes: () =>
    fetch('/api/lambda/runtimes').then((r) => json<LambdaRuntime[]>(r)),

  lambdaRun: (
    runtime: string,
    code: string,
    packages?: string,
    functionId?: string,
    files?: LambdaFile[],
    entryPoint?: string,
    payload?: unknown,
  ) =>
    fetch('/api/lambda/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtime, code, packages, functionId, files, entryPoint, payload }),
    }).then((r) => json<LambdaResult>(r)),

  lambdaHistory: () =>
    fetch('/api/lambda/history').then((r) => json<LambdaResult[]>(r)),

  lambdaListFunctions: () =>
    fetch('/api/lambda/functions').then((r) => json<LambdaFunction[]>(r)),

  lambdaGetFunction: (id: string) =>
    fetch(`/api/lambda/functions/${id}`).then((r) => json<LambdaFunction>(r)),

  lambdaCreateFunction: (
    name: string,
    runtime: string,
    code: string,
    packages?: string,
    entryPoint?: string,
    files?: LambdaFile[],
  ) =>
    fetch('/api/lambda/functions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, runtime, code, packages, entryPoint, files }),
    }).then((r) => json<LambdaFunction>(r)),

  lambdaUpdateFunction: (
    id: string,
    fields: {
      name?: string;
      runtime?: string;
      code?: string;
      packages?: string;
      entryPoint?: string;
      files?: LambdaFile[];
    },
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

  lambdaGetEnv: (id: string) =>
    fetch(`/api/lambda/functions/${id}/env`).then((r) => json<Record<string, string>>(r)),

  lambdaSetEnv: (id: string, env: Record<string, string>) =>
    fetch(`/api/lambda/functions/${id}/env`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env }),
    }).then((r) => json<Record<string, string>>(r)),

  images: () => fetch('/api/images').then((r) => json<DockerImage[]>(r)),

  removeImage: (id: string, force = false) =>
    fetch(`/api/images/${encodeURIComponent(id)}?force=${force}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: true }>(r),
    ),

  volumes: () => fetch('/api/volumes').then((r) => json<DockerVolume[]>(r)),

  buildCache: () => fetch('/api/system/build-cache').then((r) => json<BuildCacheEntry[]>(r)),

  pruneBuildCache: () =>
    fetch('/api/system/build-cache/prune', { method: 'POST' }).then((r) =>
      json<{ ok: true; reclaimedBytes: number; cachesDeleted: number }>(r),
    ),

  prune: () =>
    fetch('/api/images/prune', { method: 'POST' }).then((r) =>
      json<{ ok: true; reclaimedBytes: number }>(r),
    ),

  bucketList: () => fetch('/api/buckets').then((r) => json<Bucket[]>(r)),

  bucketCreate: (name: string) =>
    fetch('/api/buckets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => json<{ name: string }>(r)),

  bucketDelete: (name: string) =>
    fetch(`/api/buckets/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: true }>(r),
    ),

  bucketObjects: (name: string, prefix = '') =>
    fetch(`/api/buckets/${encodeURIComponent(name)}/objects?prefix=${encodeURIComponent(prefix)}`).then(
      (r) => json<BucketListing>(r),
    ),

  bucketUpload: (name: string, key: string, file: File) =>
    fetch(`/api/buckets/${encodeURIComponent(name)}/objects/${key.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }).then((r) => json<{ key: string }>(r)),

  bucketWriteObject: (name: string, key: string, content: string, contentType = 'text/plain') =>
    fetch(`/api/buckets/${encodeURIComponent(name)}/objects/${key.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: content,
    }).then((r) => json<{ key: string }>(r)),

  bucketObjectUrl: (name: string, key: string) =>
    `/api/buckets/${encodeURIComponent(name)}/objects/${key.split('/').map(encodeURIComponent).join('/')}`,

  bucketDeleteObject: (name: string, key: string) =>
    fetch(
      `/api/buckets/${encodeURIComponent(name)}/objects/${key.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'DELETE' },
    ).then((r) => json<{ ok: true }>(r)),

  gatewayList: () => fetch('/api/gateway').then((r) => json<GatewayRoute[]>(r)),

  gatewayCreate: (route: {
    name: string;
    targetType: string;
    targetId: string;
    targetPort?: number;
    method?: string;
    pathPattern?: string;
  }) =>
    fetch('/api/gateway', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(route),
    }).then((r) => json<GatewayRoute>(r)),

  gatewayDelete: (id: string) =>
    fetch(`/api/gateway/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),

  gatewayTrafficSummary: (gatewayName?: string) => {
    const query = gatewayName ? `?gatewayName=${encodeURIComponent(gatewayName)}` : '';
    return fetch(`/api/gateway/traffic/summary${query}`).then((r) => json<GatewayTrafficSummary>(r));
  },

  gatewayTrafficRequests: (gatewayName?: string) => {
    const query = gatewayName ? `?gatewayName=${encodeURIComponent(gatewayName)}` : '';
    return fetch(`/api/gateway/traffic/requests${query}`).then((r) => json<GatewayTrafficRequests>(r));
  },

  databaseOverview: () =>
    fetch('/api/databases/overview').then((r) => json<DatabaseOverview>(r)),

  databaseConnections: () =>
    fetch('/api/databases/connections').then((r) => json<DatabaseConnectionDetail[]>(r)),

  databaseGetConnection: (id: string) =>
    fetch(`/api/databases/connections/${id}`).then((r) => json<DatabaseConnectionDetail>(r)),

  databaseCreateConnection: (body: {
    name: string;
    engine: string;
    config: Record<string, unknown>;
  }) =>
    fetch('/api/databases/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<DatabaseConnectionDetail>(r)),

  databaseUpdateConnection: (
    id: string,
    body: {
      name?: string;
      engine?: string;
      config?: Record<string, unknown>;
    },
  ) =>
    fetch(`/api/databases/connections/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<DatabaseConnectionDetail>(r)),

  databaseDeleteConnection: (id: string) =>
    fetch(`/api/databases/connections/${id}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: true }>(r),
    ),

  databaseTestConnection: (id: string) =>
    fetch(`/api/databases/connections/${id}/test`, { method: 'POST' }).then((r) =>
      json<Record<string, unknown>>(r),
    ),

  databaseSchema: (id: string, database?: string) => {
    const query = database?.trim() ? `?database=${encodeURIComponent(database.trim())}` : '';
    return fetch(`/api/databases/connections/${id}/schema${query}`).then((r) =>
      json<Record<string, unknown>>(r),
    );
  },

  databaseRead: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/databases/connections/${id}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<Record<string, unknown>>(r)),

  databaseMutate: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/databases/connections/${id}/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<DatabaseConfirmationPreview | Record<string, unknown>>(r)),

  databaseMigrate: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/databases/connections/${id}/migrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<DatabaseConfirmationPreview | Record<string, unknown>>(r)),

  databaseGrant: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/databases/connections/${id}/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<DatabaseConfirmationPreview | Record<string, unknown>>(r)),

  databaseOperations: (limit = 25) =>
    fetch(`/api/databases/operations?limit=${limit}`).then((r) =>
      json<DatabaseOperationOverview[]>(r),
    ),

  databaseJobs: (limit = 25) =>
    fetch(`/api/databases/jobs?limit=${limit}`).then((r) => json<DatabaseJobOverview[]>(r)),

  databaseJob: (id: string) =>
    fetch(`/api/databases/jobs/${id}`).then((r) => json<DatabaseJobOverview>(r)),

  databaseJobDownloadUrl: (id: string) => `/api/databases/jobs/${id}/download`,

  databaseBackup: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/databases/connections/${id}/backup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<DatabaseConfirmationPreview | Record<string, unknown>>(r)),

  databaseRestore: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/databases/connections/${id}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<DatabaseConfirmationPreview | Record<string, unknown>>(r)),

  assistantPlan: (prompt: string, messages?: unknown[]) =>
    fetch('/api/assistant/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, messages }),
    }).then((r) => json<AssistantTurn>(r)),

  /** Streaming version of assistantPlan — returns an async generator that
   *  yields SSE events as they arrive: {type:'text', delta} for incremental
   *  text, {type:'turn', ...AssistantTurn} when the turn completes, or
   *  {type:'error', message} on failure. `messages`, if given, is the prior
   *  conversation so far — pass it on every follow-up prompt in the same
   *  session so the model retains context (e.g. "the function" resolving to
   *  whatever was just discussed), not just the latest message in isolation. */
  assistantPlanStream: (prompt: string, messages?: unknown[]) =>
    fetch('/api/assistant/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, messages }),
    }).then((r) => {
      if (!r.ok) throw new Error(`Assistant plan failed: ${r.statusText}`);
      return parseSSE(r);
    }),

  assistantConfirm: (messages: unknown[], results: { toolUseId: string; ok: boolean; content: unknown }[]) =>
    fetch('/api/assistant/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, results }),
    }).then((r) => json<AssistantTurn>(r)),

  /** Streaming version of assistantConfirm — same SSE protocol as
   *  assistantPlanStream. */
  assistantConfirmStream: (
    messages: unknown[],
    results: { toolUseId: string; ok: boolean; content: unknown }[],
  ) =>
    fetch('/api/assistant/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, results }),
    }).then((r) => {
      if (!r.ok) throw new Error(`Assistant confirm failed: ${r.statusText}`);
      return parseSSE(r);
    }),

  assistantListSessions: () =>
    fetch('/api/assistant/sessions').then((r) => json<AssistantSessionSummary[]>(r)),

  /** Ask Claude for a short friendly title summarizing a conversation. Best
   *  effort — callers fall back to a local heuristic if this fails. */
  assistantGenerateTitle: (prompt: string, reply: string) =>
    fetch('/api/assistant/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, reply }),
    }).then((r) => json<{ name: string }>(r)),

  assistantGetSession: (id: string) =>
    fetch(`/api/assistant/sessions/${id}`).then((r) => json<AssistantSession>(r)),

  assistantCreateSession: (name: string, state: AssistantSessionState) =>
    fetch('/api/assistant/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, state }),
    }).then((r) => json<AssistantSession>(r)),

  assistantUpdateSession: (id: string, fields: { name?: string; state?: AssistantSessionState }) =>
    fetch(`/api/assistant/sessions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then((r) => json<AssistantSession>(r)),

  assistantDeleteSession: (id: string) =>
    fetch(`/api/assistant/sessions/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),
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
