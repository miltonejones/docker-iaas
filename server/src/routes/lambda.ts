import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import tar from 'tar-stream';
import { docker, dockyardNetworkConfig, ensureImage } from '../docker.js';
import { getAuthUser } from '../auth.js';
import {
  listFunctions,
  getFunction,
  createFunction,
  updateFunction,
  deleteFunction,
  getFunctionEnv,
  setFunctionEnv,
  getFunctionFiles,
  setFunctionFiles,
  type FunctionFileRow,
} from '../db.js';

export const lambdaRouter = Router();

// ---------------------------------------------------------------------------
// Runtimes
// ---------------------------------------------------------------------------

interface RuntimeDef {
  id: string;
  name: string;
  image: string;
  icon: string;
  /** Default entry-point filename when none is set explicitly. */
  defaultEntry: string;
  /** Build the run command for a given (already-written-to-disk) entry file. */
  runCmd: (entryPath: string) => string;
  /** Install command for a whitespace-separated package list. */
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

/** A file to place in the function's working directory before execution. */
export interface FunctionFile {
  path: string;
  content: string;
}

/** Pack a set of files into a tar buffer rooted at `/`, so extracting it into
 *  a container path (e.g. /fn) reproduces the exact relative directory
 *  structure — this is what makes `require('./lib/util')` and barrel-file
 *  imports resolve normally, instead of everything living in one flat file. */
function packFilesToTar(files: FunctionFile[]): Promise<Buffer> {
  // Entries are named "fn/<path>" and extracted at container root, so they
  // land at WORKDIR (/fn/<path>) — Docker's extractor creates the
  // intermediate directories implied by nested paths automatically.
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

/** Build the Cmd array that just runs the entry file — used whenever
 *  packages are already baked into the image (see ensureCachedImage), so no
 *  install step is needed at request time. */
function buildRunCmd(def: RuntimeDef, entryPath: string): string[] {
  return ['sh', '-c', `cd ${WORKDIR} && ${def.runCmd(entryPath)}`];
}

// ---------------------------------------------------------------------------
// Package-install image cache
//
// Every invocation runs in a fresh, disposable container (see runLambda), so
// without caching, "npm install <packages>" (or pip/apk) reruns from scratch
// on every single call — that's the actual cost, not how many functions or
// files exist. Instead, the install step runs once per unique
// (runtime, package list) combination, and the resulting container is
// committed as a real Docker image; every later call with the same package
// list reuses that image directly and skips installing entirely.
// ---------------------------------------------------------------------------

/** In-memory de-dup so concurrent calls with an uncached package list don't
 *  each kick off a redundant install+commit — they await the same build. */
const pendingImageBuilds = new Map<string, Promise<void>>();

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

/** Ensure an image tagged `cacheTag` exists with `packages` already
 *  installed, building it (once) if necessary. */
async function ensureCachedImage(def: RuntimeDef, packages: string[], cacheTag: string): Promise<void> {
  if (await imageExists(cacheTag)) return;

  const inFlight = pendingImageBuilds.get(cacheTag);
  if (inFlight) return inFlight;

  const build = (async () => {
    // Re-check after acquiring the dedup slot — another build may have
    // finished while this call was waiting to get here.
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
      });
      await builder.start();
      const waitResult = await builder.wait();
      if ((waitResult.StatusCode ?? 1) !== 0) {
        const logBuf = await builder.logs({ stdout: true, stderr: true, timestamps: false });
        const { stderr } = splitLogStream(logBuf as unknown as Buffer);
        throw new Error(stderr || `Package install failed (exit ${waitResult.StatusCode}).`);
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

// ---------------------------------------------------------------------------
// History (in-memory, last 20)
// ---------------------------------------------------------------------------

interface HistoryEntry {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  runtime: string;
  timestamp: string;
}

const history: HistoryEntry[] = [];

function addHistory(entry: HistoryEntry): void {
  history.unshift(entry);
  if (history.length > 20) history.length = 20;
}

// ---------------------------------------------------------------------------
// Execution engine (reused by the /run route and the gateway's lambda target)
// ---------------------------------------------------------------------------

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/** Run a set of files (a multi-file working directory) in a fresh,
 *  disposable container and return its output. `entryPath` is the file
 *  actually executed — everything else (barrel files, lib modules, etc) is
 *  written alongside it at its real relative path, so ordinary
 *  imports/requires resolve exactly like they would in a normal project. */
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
      HostConfig: {
        AutoRemove: false, // we remove manually after reading logs
        Memory: 256 * 1024 * 1024, // 256 MB limit
      },
      ...dockyardNetworkConfig(),
    });

    // Write the function's files into the container before starting it —
    // putArchive extracts a tar into a path inside the (stopped) container,
    // which is how multi-file working directories get there intact.
    const tarBuf = await packFilesToTar(files);
    await container.putArchive(tarBuf, { path: '/' });

    await container.start();

    // Wait for the container to exit, with a timeout.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      container!.stop({ t: 0 }).catch(() => {});
    }, TIMEOUT_MS);

    const waitResult = await container.wait();
    clearTimeout(timer);

    const durationMs = Date.now() - started;

    // Grab logs.
    const logBuf = await container.logs({
      stdout: true,
      stderr: true,
      timestamps: false,
    });

    // Strip the 8-byte multiplex header from each frame.
    const { stdout, stderr } = splitLogStream(logBuf as unknown as Buffer);

    const exitCode = waitResult.StatusCode ?? 1;

    return {
      stdout: timedOut ? `${stdout}\n[Execution timed out after ${TIMEOUT_MS / 1000}s]` : stdout,
      stderr,
      exitCode: timedOut ? -1 : exitCode,
      durationMs,
    };
  } finally {
    // Always clean up the temporary container.
    if (container) {
      container.remove({ force: true, v: true }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// List available runtimes.
lambdaRouter.get('/runtimes', (_req: Request, res: Response) => {
  const list = Object.values(RUNTIMES).map((r) => ({
    id: r.id,
    name: r.name,
    image: r.image,
    icon: r.icon,
  }));
  res.json(list);
});

/** Extra files supplied ad-hoc by the "Run" button (not yet saved). */
interface RunFileInput {
  path: string;
  content: string;
}

// Execute code in a temporary container. Supports both the legacy single-file
// shape ({ code }) and multi-file testing ({ code, files, entryPoint }) —
// `files` holds any additional modules (barrel files, lib code) alongside
// the entry file, addressed by their real relative path.
lambdaRouter.post('/run', async (req: Request, res: Response) => {
  const { runtime, code, packages, functionId, files, entryPoint, payload } = req.body as {
    runtime?: string;
    code?: string;
    packages?: string;
    functionId?: string;
    files?: RunFileInput[];
    entryPoint?: string;
    payload?: unknown;
  };

  const def = RUNTIMES[runtime ?? ''];
  if (!def) {
    res.status(400).json({ error: `Unknown runtime "${runtime}". Use: ${Object.keys(RUNTIMES).join(', ')}.` });
    return;
  }
  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    res.status(400).json({ error: 'No code provided.' });
    return;
  }

  const entryPath = entryPoint?.trim() || def.defaultEntry;
  const extraFiles = (files || []).filter((f) => f.path && f.path !== entryPath);
  const allFiles: FunctionFile[] = [{ path: entryPath, content: code }, ...extraFiles];

  const pkgList = (packages || '').trim().split(/\s+/).filter(Boolean);
  const started = Date.now();

  try {
    // Testing a saved function also gets its real env vars, so "Run" in the
    // editor exercises the same configuration the gateway would use. An
    // optional `payload` is provided to the function the same way the gateway
    // delivers an incoming request: as the DOCKYARD_REQUEST environment
    // variable (JSON).
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
    res.json(entry);
  } catch (err) {
    res.status(502).json({
      error: (err as Error).message,
      durationMs: Date.now() - started,
      runtime: def.id,
      timestamp: new Date().toISOString(),
    });
  }
});

// Recent execution history.
lambdaRouter.get('/history', (_req: Request, res: Response) => {
  res.json(history);
});

// ---------------------------------------------------------------------------
// Persisted function CRUD
// ---------------------------------------------------------------------------

/** A saved function's entry-point path — the file that's actually executed.
 *  Falls back to the runtime's conventional default (index.js/.py/.sh) when
 *  the function predates multi-file support. */
export function entryPathOf(r: import('../db.js').LambdaFunctionRow): string {
  return r.entry_point || RUNTIMES[r.runtime]?.defaultEntry || 'index.js';
}

/** The full runnable file set for a saved function: the entry file (whose
 *  content lives on functions.code) plus any additional files/modules. */
export function fullFileSet(r: import('../db.js').LambdaFunctionRow): FunctionFile[] {
  const entryPath = entryPathOf(r);
  const extra = getFunctionFiles(r.id).filter((f) => f.path !== entryPath);
  return [{ path: entryPath, content: r.code }, ...extra];
}

// List all saved functions.
function toJson(r: import('../db.js').LambdaFunctionRow) {
  return {
    id: r.id,
    name: r.name,
    runtime: r.runtime,
    code: r.code,
    packages: r.packages,
    entryPoint: entryPathOf(r),
    files: getFunctionFiles(r.id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

lambdaRouter.get('/functions', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(listFunctions(userId).map(toJson));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get a single function.
lambdaRouter.get('/functions/:id', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const row = getFunction(req.params.id, userId);
    if (!row) {
      res.status(404).json({ error: 'Function not found.' });
      return;
    }
    res.json(toJson(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Create a new function.
lambdaRouter.post('/functions', (req: Request, res: Response) => {
  try {
    const { name, runtime, code, packages, entryPoint, files } = req.body as {
      name?: string;
      runtime?: string;
      code?: string;
      packages?: string;
      entryPoint?: string;
      files?: FunctionFileRow[];
    };
    if (!name?.trim()) {
      res.status(400).json({ error: 'A function name is required.' });
      return;
    }
    const id = `fn-${Math.random().toString(36).slice(2, 8)}`;
    const resolvedEntry = entryPoint?.trim() || RUNTIMES[runtime || 'node']?.defaultEntry || null;
    const row = createFunction(id, name.trim(), runtime || 'node', code || '', packages || '', resolvedEntry, getAuthUser(req)?.userId);
    if (files?.length) {
      setFunctionFiles(id, files.filter((f) => f.path && f.path !== resolvedEntry));
    }
    res.status(201).json(toJson(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Update an existing function.
lambdaRouter.put('/functions/:id', (req: Request, res: Response) => {
  try {
    const { name, runtime, code, packages, entryPoint, files } = req.body as {
      name?: string;
      runtime?: string;
      code?: string;
      packages?: string;
      entryPoint?: string;
      files?: FunctionFileRow[];
    };
    const row = updateFunction(req.params.id, { name, runtime, code, packages, entryPoint });
    if (!row) {
      res.status(404).json({ error: 'Function not found.' });
      return;
    }
    if (files !== undefined) {
      const entry = entryPathOf(row);
      setFunctionFiles(row.id, files.filter((f) => f.path && f.path !== entry));
    }
    res.json(toJson(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Delete a function.
lambdaRouter.delete('/functions/:id', (req: Request, res: Response) => {
  try {
    const deleted = deleteFunction(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Function not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Per-function environment variables — stored separately from code so
// secrets never end up rendered inline in the function's source text.
// ---------------------------------------------------------------------------

lambdaRouter.get('/functions/:id/env', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!getFunction(req.params.id, userId)) {
      res.status(404).json({ error: 'Function not found.' });
      return;
    }
    res.json(getFunctionEnv(req.params.id));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

lambdaRouter.put('/functions/:id/env', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    if (!getFunction(req.params.id, userId)) {
      res.status(404).json({ error: 'Function not found.' });
      return;
    }
    const { env } = req.body as { env?: Record<string, string> };
    setFunctionEnv(req.params.id, env || {});
    res.json(getFunctionEnv(req.params.id));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Log stream demux (same as containers.ts)
// ---------------------------------------------------------------------------

function splitLogStream(buf: Buffer): { stdout: string; stderr: string } {
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
