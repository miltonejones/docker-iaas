import { Router, type Request, type Response } from 'express';
import { docker, dockyardNetworkConfig } from '../docker.js';
import {
  listFunctions,
  getFunction,
  createFunction,
  updateFunction,
  deleteFunction,
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
  /** Build the Cmd array from user code. */
  cmd: (code: string) => string[];
}

const RUNTIMES: Record<string, RuntimeDef> = {
  node: {
    id: 'node',
    name: 'Node.js',
    image: 'node:20-alpine',
    icon: '🟢',
    cmd: (code) => ['node', '-e', code],
  },
  python: {
    id: 'python',
    name: 'Python',
    image: 'python:3.12-slim',
    icon: '🐍',
    cmd: (code) => ['python3', '-c', code],
  },
  sh: {
    id: 'sh',
    name: 'Shell',
    image: 'alpine:latest',
    icon: '💻',
    cmd: (code) => ['sh', '-c', code],
  },
};

const TIMEOUT_MS = 30_000;

/** Build the Cmd array. If packages are specified, wrap in a shell script that
 *  installs them first, then runs the code via heredoc (no escaping issues). */
function buildCmd(
  def: RuntimeDef,
  code: string,
  packages: string[],
): string[] {
  if (packages.length === 0) {
    return def.cmd(code);
  }

  const pkgStr = packages.join(' ');

  switch (def.id) {
    case 'node':
      return [
        'sh',
        '-c',
        `cat > /tmp/code.js << "DOCKYARD_EOF"\n${code}\nDOCKYARD_EOF\nnpm install ${pkgStr} && node /tmp/code.js`,
      ];
    case 'python':
      return [
        'sh',
        '-c',
        `cat > /tmp/code.py << "DOCKYARD_EOF"\n${code}\nDOCKYARD_EOF\npip install ${pkgStr} && python3 /tmp/code.py`,
      ];
    case 'sh':
      return ['sh', '-c', `apk add ${pkgStr} && ${code}`];
    default:
      return def.cmd(code);
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
// Helpers
// ---------------------------------------------------------------------------

async function ensureImage(image: string): Promise<void> {
  const tagged = image.includes(':') ? image : `${image}:latest`;
  const images = await docker.listImages();
  const present = images.some((img) => (img.RepoTags || []).includes(tagged));
  if (present) return;

  await new Promise<void>((resolve, reject) => {
    docker.pull(tagged, (err: unknown, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (doneErr: unknown) =>
        doneErr ? reject(doneErr) : resolve(),
      );
    });
  });
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

// Execute code in a temporary container.
lambdaRouter.post('/run', async (req: Request, res: Response) => {
  const { runtime, code, packages } = req.body as {
    runtime?: string;
    code?: string;
    packages?: string;
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

  const pkgList = (packages || '').trim().split(/\s+/).filter(Boolean);
  const cmd = buildCmd(def, code, pkgList);

  const started = Date.now();
  let container: Awaited<ReturnType<typeof docker.createContainer>> | null = null;

  try {
    await ensureImage(def.image);

    container = await docker.createContainer({
      Image: def.image,
      Cmd: cmd,
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        AutoRemove: false, // we remove manually after reading logs
        Memory: 256 * 1024 * 1024, // 256 MB limit
      },
      ...dockyardNetworkConfig(),
    });

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

    const entry: HistoryEntry = {
      stdout,
      stderr,
      exitCode: timedOut ? -1 : exitCode,
      durationMs,
      runtime: def.id,
      timestamp: new Date().toISOString(),
    };
    addHistory(entry);

    if (timedOut) {
      entry.stdout += `\n[Execution timed out after ${TIMEOUT_MS / 1000}s]`;
    }

    res.json(entry);
  } catch (err) {
    const durationMs = Date.now() - started;
    res.status(502).json({
      error: (err as Error).message,
      durationMs,
      runtime: def.id,
      timestamp: new Date().toISOString(),
    });
  } finally {
    // Always clean up the temporary container.
    if (container) {
      container.remove({ force: true, v: true }).catch(() => {});
    }
  }
});

// Recent execution history.
lambdaRouter.get('/history', (_req: Request, res: Response) => {
  res.json(history);
});

// ---------------------------------------------------------------------------
// Persisted function CRUD
// ---------------------------------------------------------------------------

// List all saved functions.
function toJson(r: import('../db.js').LambdaFunctionRow) {
  return {
    id: r.id,
    name: r.name,
    runtime: r.runtime,
    code: r.code,
    packages: r.packages,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

lambdaRouter.get('/functions', (_req: Request, res: Response) => {
  try {
    res.json(listFunctions().map(toJson));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get a single function.
lambdaRouter.get('/functions/:id', (req: Request, res: Response) => {
  try {
    const row = getFunction(req.params.id);
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
    const { name, runtime, code, packages } = req.body as {
      name?: string;
      runtime?: string;
      code?: string;
      packages?: string;
    };
    if (!name?.trim()) {
      res.status(400).json({ error: 'A function name is required.' });
      return;
    }
    const id = `fn-${Math.random().toString(36).slice(2, 8)}`;
    const row = createFunction(id, name.trim(), runtime || 'node', code || '', packages || '');
    res.status(201).json(toJson(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Update an existing function.
lambdaRouter.put('/functions/:id', (req: Request, res: Response) => {
  try {
    const { name, runtime, code, packages } = req.body as {
      name?: string;
      runtime?: string;
      code?: string;
      packages?: string;
    };
    const row = updateFunction(req.params.id, { name, runtime, code, packages });
    if (!row) {
      res.status(404).json({ error: 'Function not found.' });
      return;
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
