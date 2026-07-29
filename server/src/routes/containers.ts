import { Router, type Request, type Response } from 'express';
import { getAuthUser } from '../auth.js';
import { HttpError } from '../services/HttpError.js';
import * as containerService from '../services/containers.js';

export const containersRouter = Router();

// Re-export for backward compatibility.
export { listContainerFiles, probeContainerEndpoint, stripLogHeaders, backgroundExecOutputs, readFile, copyToContainer } from '../services/containers.js';

function sendError(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 502;
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unknown error.' });
}

// ── List ──────────────────────────────────────────────────────

containersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : undefined;
    res.json(await containerService.list(userId, projectId));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Launch ────────────────────────────────────────────────────

containersRouter.post('/', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const result = await containerService.launch(userId, req.body);
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

// ── Write file ────────────────────────────────────────────────

containersRouter.post('/:id/files', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(await containerService.writeFile(req.params.id, userId, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Exec output polling ───────────────────────────────────────

containersRouter.get('/execs/:execId/output', async (req: Request, res: Response) => {
  const entry = containerService.getExecOutput(req.params.execId);
  if (!entry) {
    res.status(404).json({ error: `Exec "${req.params.execId}" output not found.` });
    return;
  }
  res.json(entry);
});

// ── Exec ──────────────────────────────────────────────────────

containersRouter.post('/:id/exec', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(await containerService.execCommand(req.params.id, userId, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Exec stream (SSE) — stays in route ────────────────────────

containersRouter.post('/:id/exec/stream', async (req: Request, res: Response) => {
  const userId = getAuthUser(req)?.userId;
  const { command, workingDir, timeoutSeconds } = req.body as Record<string, unknown>;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.length > 32 ||
    command.some((part) => typeof part !== 'string' || !part || part.length > 4096)
  ) {
    res.status(400).json({ error: 'command must be a non-empty array of up to 32 non-empty string arguments.' });
    return;
  }
  const commandArgs = command as string[];
  if (
    workingDir !== undefined &&
    (typeof workingDir !== 'string' ||
      !workingDir.startsWith('/') ||
      /\.\.(?:\/|$)/.test(workingDir) ||
      workingDir.length > 4096)
  ) {
    res.status(400).json({ error: 'workingDir must be an absolute container path without "..".' });
    return;
  }

  try {
    const { docker } = await import('../docker.js');
    const container = docker.getContainer(req.params.id);
    const info = await container.inspect();
    if (info.Config?.Labels?.['iaas.system']) {
      res.status(403).json({ error: 'System-managed containers cannot execute assistant commands.' });
      return;
    }
    if (info.Config?.Labels?.['iaas.assistant-managed'] !== 'true') {
      res.status(403).json({ error: 'Assistant commands are limited to containers created by the assistant.' });
      return;
    }
    if (!info.State?.Running) {
      res.status(409).json({ error: 'Container is not running — start it before executing a command.' });
      return;
    }

    const exec = await container.exec({
      Cmd: commandArgs,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: workingDir,
    });

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const { recordAuditLog } = await import('../db/audit.js');
    recordAuditLog('container.exec.stream', 'container', req.params.id, userId, commandArgs[0]);
    res.status(200);

    const send = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const timeout = typeof timeoutSeconds === 'number' && timeoutSeconds >= 1 && timeoutSeconds <= 600
      ? timeoutSeconds * 1000 : undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeout) {
      timeoutHandle = setTimeout(() => {
        send({ type: 'error', message: `Command timed out after ${timeoutSeconds}s.` });
        res.end();
      }, timeout);
    }

    send({ type: 'start', command: commandArgs, workingDir: workingDir ?? null });

    const stream = await exec.start({ hijack: true, stdin: false });
    let buf = Buffer.alloc(0);

    stream.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const len = buf.readUInt32BE(4);
        if (buf.length < 8 + len) break;
        const payload = buf.subarray(8, 8 + len).toString('utf8');
        buf = buf.subarray(8 + len);
        send({ type: 'output', text: payload });
      }
    });

    stream.on('end', async () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      try {
        const result = await exec.inspect();
        send({ type: 'done', exitCode: result.ExitCode ?? null });
      } catch (err) {
        send({ type: 'done', exitCode: null, error: (err as Error).message });
      }
      res.end();
    });

    stream.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (!res.writableFinished) {
        send({ type: 'error', message: (err as Error).message });
      }
      res.end();
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: (err as Error).message });
    }
  }
});

// ── Update env ────────────────────────────────────────────────

containersRouter.post('/:id/env', async (req: Request, res: Response) => {
  try {
    res.json(await containerService.updateEnv(req.params.id, getAuthUser(req)?.userId, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Replace in file ───────────────────────────────────────────

containersRouter.post('/:id/files/replace', async (req: Request, res: Response) => {
  try {
    const result = await containerService.replaceInFile(req.params.id, getAuthUser(req)?.userId, req.body);
    res.json({ path: req.body.path, replaced: true, occurrences: result.replacements });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      res.json({ path: req.body.path, replaced: false, reason: err.message });
      return;
    }
    sendError(res, err);
  }
});

// ── Bulk write files ──────────────────────────────────────────

containersRouter.post('/:id/files/bulk', async (req: Request, res: Response) => {
  try {
    res.json(await containerService.writeFiles(req.params.id, getAuthUser(req)?.userId, req.body?.files));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Lifecycle ─────────────────────────────────────────────────

for (const action of ['start', 'stop', 'restart'] as const) {
  containersRouter.post(`/:id/${action}`, async (req: Request, res: Response) => {
    try {
      const userId = getAuthUser(req)?.userId;
      await containerService[action](req.params.id, userId);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });
}

containersRouter.delete('/:id', async (req: Request, res: Response) => {
  const force = req.query.force === 'true';
  try {
    const userId = getAuthUser(req)?.userId;
    await containerService.remove(req.params.id, userId, force);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ── Inspect ───────────────────────────────────────────────────

containersRouter.get('/:id/inspect', async (req: Request, res: Response) => {
  try {
    res.json(await containerService.inspect(req.params.id));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Logs ──────────────────────────────────────────────────────

containersRouter.get('/:id/logs', async (req: Request, res: Response) => {
  try {
    const tail = Number(req.query.tail ?? 200);
    const text = await containerService.logs(req.params.id, tail);
    res.type('text/plain').send(text);
  } catch (err) {
    sendError(res, err);
  }
});

// ── List container files ──────────────────────────────────────

containersRouter.post('/:id/files/list', async (req: Request, res: Response) => {
  try {
    res.json(await containerService.listContainerFiles(
      req.params.id,
      req.body.path as string | undefined,
      req.body.maxDepth as number | undefined,
    ));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Probe endpoint ────────────────────────────────────────────

containersRouter.post('/:id/probe', async (req: Request, res: Response) => {
  try {
    res.json(await containerService.probeContainerEndpoint(
      req.params.id,
      typeof req.body.port === 'number' ? req.body.port : Number(req.body.port) || 80,
      typeof req.body.path === 'string' ? req.body.path : '/',
      typeof req.body.method === 'string' ? req.body.method.toUpperCase() : 'GET',
    ));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Read file from container ─────────────────────────────────

containersRouter.post('/:id/files/read', async (req: Request, res: Response) => {
  try {
    const path = String(req.body.path ?? '');
    res.json(await containerService.readFile(req.params.id, path));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Copy to container ────────────────────────────────────────

containersRouter.post('/:id/files/copy', async (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    // Accept both nested { source: {...} } (direct API) and flat params (tool call).
    const source = (body.source as Record<string, unknown>) ?? {
      type: body.sourceType,
      containerId: body.sourceContainerId,
      path: body.sourcePath,
      bucket: body.sourceBucket,
      key: body.sourceKey,
    };
    const destPath = String((body.destPath ?? body.path ?? ''));
    res.json(await containerService.copyToContainer({
      source: source as any,
      destId: req.params.id,
      destPath,
    }, getAuthUser(req)?.userId));
  } catch (err) {
    sendError(res, err);
  }
});
