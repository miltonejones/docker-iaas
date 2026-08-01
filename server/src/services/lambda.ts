import crypto from 'node:crypto';
import tar from 'tar-stream';
import { docker, dockyardNetworkConfig, ensureImage } from '../docker.js';
import {
  listFunctions,
  getFunction,
  createFunction as createFunctionRow,
  updateFunction as updateFunctionRow,
  deleteFunction,
  getFunctionEnv,
  setFunctionEnv,
  getFunctionFiles,
  setFunctionFiles,
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- TODO(gap-00)
  type FunctionFileRow,
  getProject,
} from '../db.js';
import { HttpError } from './HttpError.js';
import type { CreateFunctionInput, UpdateFunctionInput } from './types.js';

// ── Runtimes ──────────────────────────────────────────────────

interface RuntimeDef {
  id: string;
  name: string;
  image: string;
  icon: string;
  defaultEntry: string;
  runCmd: (entryPath: string) => string;
  installCmd: (pkgStr: string) => string;
}

const RUNTIMES: Record<string, RuntimeDef> = {
  node: {
    id: 'node',
    name: 'Node.js',
    image: 'node:20-alpine',
    icon: '🟢',
    defaultEntry: 'index.js',
    runCmd: (entryPath) => `node ${entryPath}`,
    installCmd: (pkgStr) => `npm install ${pkgStr} 1>&2`,
  },
  python: {
    id: 'python',
    name: 'Python',
    image: 'python:3.12-slim',
    icon: '🐍',
    defaultEntry: 'index.py',
    runCmd: (entryPath) => `python3 ${entryPath}`,
    installCmd: (pkgStr) => `pip install ${pkgStr} 1>&2`,
  },
  sh: {
    id: 'sh',
    name: 'Shell',
    image: 'alpine:latest',
    icon: '💻',
    defaultEntry: 'index.sh',
    runCmd: (entryPath) => `sh ${entryPath}`,
    installCmd: (pkgStr) => `apk add ${pkgStr} 1>&2`,
  },
};

const TIMEOUT_MS = 30_000;
const WORKDIR = '/fn';

// ── Types ─────────────────────────────────────────────────────

export interface FunctionFile {
  path: string;
  content: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

interface HistoryEntry {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  runtime: string;
  timestamp: string;
}

// ── Module-scoped state ───────────────────────────────────────

const history: HistoryEntry[] = [];

function addHistory(entry: HistoryEntry): void {
  history.unshift(entry);
  if (history.length > 20) history.length = 20;
}

const pendingImageBuilds = new Map<string, Promise<void>>();

// ── Tar packaging ─────────────────────────────────────────────

function packFilesToTar(files: FunctionFile[]): Promise<Buffer> {
  const prefix = WORKDIR.replace(/^\//, '');
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on('data', (chunk: Buffer) => chunks.push(chunk));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);
    for (const file of files) {
      const buf = Buffer.from(file.content, 'utf8');
      pack.entry({ name: `${prefix}/${file.path}`, size: buf.length }, buf);
    }
    pack.finalize();
  });
}

function buildRunCmd(def: RuntimeDef, entryPath: string): string[] {
  return ['sh', '-c', `cd ${WORKDIR} && ${def.runCmd(entryPath)}`];
}

// ── Image caching ─────────────────────────────────────────────

function cacheTagFor(runtimeId: string, packages: string[]): string {
  const key = `${runtimeId}:${[...packages].sort().join(' ')}`;
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 20);
  return `dockyard-lambda-cache:${runtimeId}-${hash}`;
}

async function imageExists(tag: string): Promise<boolean> {
  try {
    await docker.getImage(tag).inspect();
    return true;
  } catch {
    return false;
  }
}

async function ensureCachedImage(def: RuntimeDef, packages: string[], cacheTag: string): Promise<void> {
  if (await imageExists(cacheTag)) return;

  const inFlight = pendingImageBuilds.get(cacheTag);
  if (inFlight) return inFlight;

  const build = (async () => {
    if (await imageExists(cacheTag)) return;

    await ensureImage(def.image);
    const install = def.installCmd(packages.join(' '));
    let builder: Awaited<ReturnType<typeof docker.createContainer>> | null = null;
    try {
      builder = await docker.createContainer({
        Image: def.image,
        Cmd: ['sh', '-c', `mkdir -p ${WORKDIR} && cd ${WORKDIR} && ${install}`],
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        HostConfig: { AutoRemove: false },
        Labels: { 'iaas.ephemeral': 'lambda' },
      });
      await builder.start();
      const waitResult = await builder.wait();
      if ((waitResult.StatusCode ?? 1) !== 0) {
        const logBuf = await builder.logs({ stdout: true, stderr: true, timestamps: false });
        const { stderr: errText } = splitLogStream(logBuf as unknown as Buffer);
        throw new Error(errText || `Package install failed (exit ${waitResult.StatusCode}).`);
      }
      await builder.commit({ repo: cacheTag.split(':')[0], tag: cacheTag.split(':')[1] });
    } finally {
      if (builder) builder.remove({ force: true, v: true }).catch(() => {});
    }
  })();

  pendingImageBuilds.set(cacheTag, build);
  try {
    await build;
  } finally {
    pendingImageBuilds.delete(cacheTag);
  }
}

// ── Log demux ─────────────────────────────────────────────────

export function splitLogStream(buf: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const stream = buf.readUInt8(offset);
    const len = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + len;
    if (end > buf.length) break;
    const chunk = buf.subarray(start, end);
    if (stream === 1) out.push(chunk);
    else err.push(chunk);
    offset = end;
  }
  if (out.length === 0 && err.length === 0) {
    return { stdout: buf.toString('utf8'), stderr: '' };
  }
  return {
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
  };
}

export { splitLogStream as stripLogHeaders };

// ── Execution engine ──────────────────────────────────────────

export async function runLambda(
  runtimeId: string,
  files: FunctionFile[],
  entryPath: string,
  packages: string[],
  extraEnv?: string[],
): Promise<RunResult> {
  const def = RUNTIMES[runtimeId];
  if (!def) {
    throw new Error(`Unknown runtime "${runtimeId}". Use: ${Object.keys(RUNTIMES).join(', ')}.`);
  }
  if (files.length === 0 || !files.some((f) => f.content.trim())) {
    throw new Error('No code provided.');
  }

  const cmd = buildRunCmd(def, entryPath);
  const started = Date.now();
  let container: Awaited<ReturnType<typeof docker.createContainer>> | null = null;

  try {
    let image = def.image;
    if (packages.length > 0) {
      const cacheTag = cacheTagFor(runtimeId, packages);
      await ensureCachedImage(def, packages, cacheTag);
      image = cacheTag;
    } else {
      await ensureImage(def.image);
    }

    container = await docker.createContainer({
      Image: image,
      Cmd: cmd,
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      Env: extraEnv,
      Labels: { 'iaas.ephemeral': 'lambda' },
      HostConfig: {
        AutoRemove: false,
        Memory: 256 * 1024 * 1024,
      },
      ...dockyardNetworkConfig(),
    });

    const tarBuf = await packFilesToTar(files);
    await container.putArchive(tarBuf, { path: '/' });

    await container.start();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      container!.stop({ t: 0 }).catch(() => {});
    }, TIMEOUT_MS);

    const waitResult = await container.wait();
    clearTimeout(timer);

    const durationMs = Date.now() - started;

    const logBuf = await container.logs({
      stdout: true,
      stderr: true,
      timestamps: false,
    });

    const { stdout, stderr } = splitLogStream(logBuf as unknown as Buffer);

    const exitCode = waitResult.StatusCode ?? 1;

    return {
      stdout: timedOut ? `${stdout}\n[Execution timed out after ${TIMEOUT_MS / 1000}s]` : stdout,
      stderr,
      exitCode: timedOut ? -1 : exitCode,
      durationMs,
    };
  } finally {
    if (container) {
      container.remove({ force: true, v: true }).catch(() => {});
    }
  }
}

// ── Entry path helpers ────────────────────────────────────────

export function entryPathOf(r: import('../db.js').LambdaFunctionRow): string {
  return r.entry_point || RUNTIMES[r.runtime]?.defaultEntry || 'index.js';
}

export function fullFileSet(r: import('../db.js').LambdaFunctionRow): FunctionFile[] {
  const entryPath = entryPathOf(r);
  const extra = getFunctionFiles(r.id).filter((f) => f.path !== entryPath);
  return [{ path: entryPath, content: r.code }, ...extra];
}

function toJson(r: import('../db.js').LambdaFunctionRow) {
  return {
    id: r.id,
    name: r.name,
    runtime: r.runtime,
    code: r.code,
    packages: r.packages,
    entryPoint: entryPathOf(r),
    files: getFunctionFiles(r.id),
    projectId: r.project_id || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── Service CRUD ──────────────────────────────────────────────

export function listRuntimes() {
  return Object.values(RUNTIMES).map((r) => ({
    id: r.id,
    name: r.name,
    image: r.image,
    icon: r.icon,
  }));
}

export function historyList(): HistoryEntry[] {
  return history;
}

export function listFunctionsList(userId?: string, projectId?: string) {
  return listFunctions(userId, projectId).map(toJson);
}

export function getFunc(id: string, userId?: string) {
  const row = getFunction(id, userId);
  if (!row) throw new HttpError(404, 'Function not found.');
  return toJson(row);
}

export function createFunc(userId: string | undefined, input: CreateFunctionInput) {
  if (!input.name?.trim()) throw new HttpError(400, 'A function name is required.');

  if (input.projectId?.trim()) {
    const project = getProject(input.projectId.trim(), userId);
    if (!project) throw new HttpError(400, 'Project not found.');
  }

  const id = `fn-${Math.random().toString(36).slice(2, 8)}`;
  const resolvedEntry = input.entryPoint?.trim() || RUNTIMES[input.runtime || 'node']?.defaultEntry || null;
  const row = createFunctionRow(
    id,
    input.name.trim(),
    input.runtime || 'node',
    input.code || '',
    input.packages || '',
    resolvedEntry,
    userId,
    input.projectId || null,
  );
  if (input.files?.length) {
    setFunctionFiles(id, input.files.filter((f) => f.path && f.path !== resolvedEntry));
  }
  return toJson(row);
}

export function updateFunc(id: string, input: UpdateFunctionInput) {
  const row = updateFunctionRow(id, {
    name: input.name,
    runtime: input.runtime,
    code: input.code,
    packages: input.packages,
    entryPoint: input.entryPoint,
    projectId: input.projectId,
  });
  if (!row) throw new HttpError(404, 'Function not found.');
  if (input.files !== undefined) {
    const entry = entryPathOf(row);
    setFunctionFiles(row.id, input.files.filter((f) => f.path && f.path !== entry));
  }
  return toJson(row);
}

export function removeFunc(id: string) {
  const deleted = deleteFunction(id);
  if (!deleted) throw new HttpError(404, 'Function not found.');
}

export function getFuncEnv(functionId: string, userId?: string) {
  if (!getFunction(functionId, userId)) {
    throw new HttpError(404, 'Function not found.');
  }
  return getFunctionEnv(functionId);
}

export function setFuncEnv(functionId: string, userId: string | undefined, env: Record<string, string>) {
  if (!getFunction(functionId, userId)) {
    throw new HttpError(404, 'Function not found.');
  }
  setFunctionEnv(functionId, env || {});
  return getFunctionEnv(functionId);
}

export async function runCode(params: {
  runtime?: string;
  code?: string;
  packages?: string;
  functionId?: string;
  files?: Array<{ path: string; content: string }>;
  entryPoint?: string;
  payload?: unknown;
}) {
  const { runtime, code, packages, functionId, files, entryPoint, payload } = params;

  const def = RUNTIMES[runtime ?? ''];
  if (!def) {
    throw new HttpError(400, `Unknown runtime "${runtime}". Use: ${Object.keys(RUNTIMES).join(', ')}.`);
  }
  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    throw new HttpError(400, 'No code provided.');
  }

  const entryPath = entryPoint?.trim() || def.defaultEntry;
  const extraFiles = (files || []).filter((f) => f.path && f.path !== entryPath);
  const allFiles: FunctionFile[] = [{ path: entryPath, content: code }, ...extraFiles];

  const pkgList = (packages || '').trim().split(/\s+/).filter(Boolean);
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- TODO(gap-00)
  const started = Date.now();

  try {
    const extraEnvParts: string[] = [];
    if (functionId) {
      for (const [k, v] of Object.entries(getFunctionEnv(functionId))) extraEnvParts.push(`${k}=${v}`);
    }
    if (payload !== undefined) {
      extraEnvParts.push(`DOCKYARD_REQUEST=${JSON.stringify(payload)}`);
    }
    const extraEnv = extraEnvParts.length > 0 ? extraEnvParts : undefined;
    const result = await runLambda(def.id, allFiles, entryPath, pkgList, extraEnv);
    const entry: HistoryEntry = {
      ...result,
      runtime: def.id,
      timestamp: new Date().toISOString(),
    };
    addHistory(entry);
    return entry;
  } catch (err) {
    throw new HttpError(502, (err as Error).message);
  }
}
