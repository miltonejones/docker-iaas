import { Router, type Request, type Response } from 'express';
import type Docker from 'dockerode';
import tar from 'tar-stream';
import { docker, dockyardNetworkConfig, ensureImage } from '../docker.js';
import { getAuthUser } from '../auth.js';
import { findPreset } from '../presets.js';

export const containersRouter = Router();

interface ContainerView {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  ports: { privatePort: number; publicPort?: number; type: string }[];
  sizeRw: number;
  sizeRootFs: number;
  presetId?: string;
  /** System-managed containers (e.g. the persistent MinIO instance) can't be removed from the UI. */
  system?: boolean;
  /** Optional free-text note set at launch time, shown as a second row in the instances list. */
  description?: string;
}

function toView(c: Docker.ContainerInfo): ContainerView {
  return {
    id: c.Id,
    name: (c.Names?.[0] || '').replace(/^\//, ''),
    image: c.Image,
    state: c.State,
    status: c.Status,
    created: c.Created,
    ports: (c.Ports || []).map((p) => ({
      privatePort: p.PrivatePort,
      publicPort: p.PublicPort,
      type: p.Type,
    })),
    sizeRw: (c as unknown as { SizeRw?: number }).SizeRw ?? 0,
    sizeRootFs: (c as unknown as { SizeRootFs?: number }).SizeRootFs ?? 0,
    presetId: c.Labels?.['iaas.preset'],
    system: !!c.Labels?.['iaas.system'],
    description: c.Labels?.['iaas.description'] || undefined,
  };
}

// List all containers, including sizes (size=true) so the UI can show per-
// instance disk footprint next to the fleet-wide totals.
containersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const list = await docker.listContainers({ all: true, size: true });
    // Lambda invocations spin up a fresh, disposable container per call and
    // tear it down immediately after — surfacing those in the container list
    // would just be create/destroy noise, so they're filtered out entirely
    // regardless of who's asking.
    const withoutEphemeral = list.filter((c) => !c.Labels?.['iaas.ephemeral']);
    const filtered = userId
      ? withoutEphemeral.filter((c) => {
          const owner = c.Labels?.['iaas.owner'];
          const system = c.Labels?.['iaas.system'];
          // System containers and containers owned by this user are visible.
          // Legacy containers with no owner label are also visible (back compat).
          return system || owner === userId || !owner;
        })
      : withoutEphemeral;
    res.json(filtered.map(toView));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

interface LaunchBody {
  presetId?: string;
  image?: string;
  name?: string;
  description?: string;
  command?: string[];
  ports?: { container: string; host: number }[];
  env?: { key: string; value: string }[];
  volumes?: string[];
  autoStart?: boolean;
  assistantManaged?: boolean;
}

// Launch a new instance from a preset (or a raw image). Pulls the image if it
// is not present locally, creates the container, and starts it by default.
containersRouter.post('/', async (req: Request, res: Response) => {
  const body = req.body as LaunchBody;
  const userId = getAuthUser(req)?.userId;
  const preset = body.presetId ? findPreset(body.presetId) : undefined;
  const image = body.image || preset?.image;
  if (!image) {
    res.status(400).json({ error: 'An image or a valid presetId is required.' });
    return;
  }

  try {
    await ensureImage(image);

    const exposedPorts: Record<string, {}> = {};
    const portBindings: Record<string, { HostPort: string }[]> = {};
    for (const p of body.ports ?? []) {
      const key = p.container.includes('/') ? p.container : `${p.container}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: String(p.host) }];
    }

    const env = (body.env ?? [])
      .filter((e) => e.key)
      .map((e) => `${e.key}=${e.value}`);

    // Build volume mounts from the preset (or explicit request).
    // Named volumes are created automatically by Docker and survive container
    // removal, so database data persists across recreate cycles.
    const volumePaths = body.volumes ?? preset?.volumes ?? [];
    const containerName = body.name || `${preset?.id ?? 'container'}-${Math.random().toString(36).slice(2, 8)}`;
    const mounts = volumePaths.length > 0
      ? volumePaths.map((dest) => {
          const slug = dest.replace(/^\//, '').replace(/\//g, '-');
          return {
            Type: 'volume' as const,
            Source: `iaas-${containerName}-${slug}`,
            Target: dest,
          };
        })
      : undefined;

    // If an explicit Cmd is provided, skip the Tty keep-alive helper since the
    // supplied command handles that itself (e.g. ["sleep","infinity"]).
    const needsTty = !body.command && preset
      ? ['ubuntu', 'debian', 'alpine', 'fedora', 'rockylinux', 'archlinux', 'node', 'python'].includes(preset.id)
      : false;

    const container = await docker.createContainer({
      Image: image,
      name: body.name || undefined,
      Cmd: body.command,
      Env: env.length ? env : undefined,
      ExposedPorts: Object.keys(exposedPorts).length ? exposedPorts : undefined,
      Labels: {
        ...(preset ? { 'iaas.preset': preset.id } : {}),
        ...(body.assistantManaged ? { 'iaas.assistant-managed': 'true' } : {}),
        ...(userId ? { 'iaas.owner': userId } : {}),
        ...(body.description?.trim() ? { 'iaas.description': body.description.trim() } : {}),
      },
      Tty: needsTty,
      HostConfig: {
        PortBindings: Object.keys(portBindings).length ? portBindings : undefined,
        RestartPolicy: { Name: 'unless-stopped' },
        Mounts: mounts,
      },
      ...dockyardNetworkConfig(),
    });

    if (body.autoStart !== false) {
      await container.start();
    }
    res.status(201).json({ id: container.id });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Write a text file into a running container — used to build a site hosted on
// an OS container (e.g. dropping index.html into an nginx container's served
// directory). The container must be running and must not be system-managed.
containersRouter.post('/:id/files', async (req: Request, res: Response) => {
  try {
    const target = String(req.body?.path ?? '');
    const rel = target.slice(1);
    if (!target.startsWith('/') || rel === '' || /\.\.(?:\/|$)/.test(target) || !/^[\w./-]+$/.test(rel)) {
      res.status(400).json({
        error: 'path must be an absolute file path using only letters, digits, "/", ".", "-", "_" (no "..").',
      });
      return;
    }
    const content = String(req.body?.content ?? '');
    const container = docker.getContainer(req.params.id);
    const info = await container.inspect();
    if (info.Config?.Labels?.['iaas.system']) {
      res.status(403).json({ error: 'This container is system-managed and cannot be written to here.' });
      return;
    }
    if (!info.State?.Running) {
      res.status(409).json({ error: 'Container is not running — start it before writing files.' });
      return;
    }
    // Build a tar whose entry name is the path relative to "/" — Docker's
    // extractor creates the intermediate directories automatically (same trick
    // the lambda runtime uses to land files at /fn/<path>).
    const buf = Buffer.from(content, 'utf8');
    const tarBuffer = await new Promise<Buffer>((resolve, reject) => {
      const pack = tar.pack();
      const chunks: Buffer[] = [];
      pack.on('data', (c: Buffer) => chunks.push(c));
      pack.on('end', () => resolve(Buffer.concat(chunks)));
      pack.on('error', reject);
      pack.entry({ name: rel, size: buf.length, mode: 0o644 }, buf);
      pack.finalize();
    });
    await container.putArchive(tarBuffer, { path: '/' });
    res.json({ ok: true, path: target });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

const MAX_EXEC_OUTPUT_BYTES = 256 * 1024;

function readExecOutput(stream: NodeJS.ReadableStream): Promise<{ output: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (size >= MAX_EXEC_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const remaining = MAX_EXEC_OUTPUT_BYTES - size;
      chunks.push(buffer.subarray(0, remaining));
      size += Math.min(buffer.length, remaining);
      truncated ||= buffer.length > remaining;
    });
    stream.once('end', () => resolve({ output: stripLogHeaders(Buffer.concat(chunks)), truncated }));
    stream.once('error', reject);
  });
}

// Execute a confirmed command in a running container that the assistant
// created. Commands are passed directly to Docker (never through a host shell).
// Buffer for background exec output, keyed by exec id.
const backgroundExecOutputs = new Map<string, { output: string; exitCode: number | null; truncated: boolean }>();

containersRouter.get('/execs/:execId/output', async (req: Request, res: Response) => {
  const entry = backgroundExecOutputs.get(req.params.execId);
  if (!entry) {
    res.status(404).json({ error: `Exec "${req.params.execId}" output not found (may have expired or not been a background exec).` });
    return;
  }
  res.json(entry);
});

containersRouter.post('/:id/exec', async (req: Request, res: Response) => {
  const { command, workingDir, background, timeoutSeconds } = req.body as Record<string, unknown>;
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
  const timeout = typeof timeoutSeconds === 'number' && timeoutSeconds >= 1 && timeoutSeconds <= 600
    ? timeoutSeconds * 1000 : undefined;

  try {
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

    if (background) {
      // Start the exec with hijack so we can capture output, but drain it
      // in the background so the caller doesn't block.
      const stream = await exec.start({ hijack: true, stdin: false });
      const execId = exec.id;
      backgroundExecOutputs.set(execId, { output: '', exitCode: null, truncated: false });

      void (async () => {
        try {
          const { output, truncated } = await readExecOutput(stream);
          const result = await exec.inspect();
          backgroundExecOutputs.set(execId, { output, exitCode: result.ExitCode ?? null, truncated });
        } catch {
          backgroundExecOutputs.delete(execId);
        }
        // Clean up after 5 minutes.
        setTimeout(() => backgroundExecOutputs.delete(execId), 5 * 60_000);
      })();

      res.json({
        command: commandArgs,
        workingDir: workingDir ?? null,
        background: true,
        execId,
      });
      return;
    }

    const stream = await exec.start({ hijack: true, stdin: false });
    const outputPromise = readExecOutput(stream);

    let output: string; let truncated: boolean;
    if (timeout) {
      const result = await Promise.race([
        outputPromise.then((r) => ({ ok: true as const, ...r })),
        new Promise<{ ok: false; error: string }>((resolve) =>
          setTimeout(() => resolve({ ok: false, error: `Command timed out after ${timeoutSeconds}s.` }), timeout)
        ),
      ]);
      if (!result.ok) {
        res.status(504).json({ error: result.error });
        return;
      }
      output = result.output;
      truncated = result.truncated;
    } else {
      ({ output, truncated } = await outputPromise);
    }

    const result = await exec.inspect();
    res.json({
      command: commandArgs,
      workingDir: workingDir ?? null,
      exitCode: result.ExitCode ?? null,
      output,
      truncated,
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Streaming variant of exec — sends output lines in real-time via SSE.
// Same validation and security model as /:id/exec.
containersRouter.post('/:id/exec/stream', async (req: Request, res: Response) => {
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

// Update environment variables on a container. Docker doesn't support mutating
// env on a running container, so this stops → snapshots config → removes
// (keeping volumes) → recreates with merged env → starts.
containersRouter.post('/:id/env', async (req: Request, res: Response) => {
  const { env: newEnv, persist } = req.body as { env?: { key: string; value: string }[]; persist?: boolean };
  if (!newEnv || !Array.isArray(newEnv) || newEnv.length === 0) {
    res.status(400).json({ error: 'env must be a non-empty array of { key, value }.' });
    return;
  }
  for (const e of newEnv) {
    if (typeof e.key !== 'string' || !e.key || typeof e.value !== 'string') {
      res.status(400).json({ error: 'Each env entry needs a non-empty string key and a string value.' });
      return;
    }
  }

  let snapshotImage: string | null = null;

  try {
    const container = docker.getContainer(req.params.id);
    const info = await container.inspect();
    if (info.Config?.Labels?.['iaas.system']) {
      res.status(403).json({ error: 'System-managed containers cannot be updated here.' });
      return;
    }

    // Stop the container so we can recreate it.
    const wasRunning = info.State?.Running ?? false;
    if (wasRunning) await container.stop();

    // --- Persist writable layer ---
    // When persist is true, snapshot the container's filesystem into a
    // temporary image via docker commit. The new container is created from
    // that snapshot, preserving every runtime file (deployed sites, installed
    // packages, config edits). The temp image is cleaned up afterwards.
    let image = info.Config?.Image ?? '';
    if (persist) {
      snapshotImage = `dockyard-snapshot-${req.params.id}-${Date.now()}`;
      await container.commit({ repo: snapshotImage });
      image = snapshotImage;
    }

    // Merge old env with new env — new keys overwrite old ones.
    const oldEnv: Record<string, string> = {};
    for (const e of info.Config?.Env ?? []) {
      const idx = e.indexOf('=');
      if (idx > 0) oldEnv[e.slice(0, idx)] = e.slice(idx + 1);
    }
    for (const e of newEnv) oldEnv[e.key] = e.value;
    const mergedEnv = Object.entries(oldEnv).map(([k, v]) => `${k}=${v}`);

    // Snapshot the existing config we need to preserve, including the
    // container's network attachments so gateway-reachable containers stay
    // connected after recreation.
    const networks = info.NetworkSettings?.Networks ?? {};
    const networkNames = Object.keys(networks);
    const createOpts: Docker.ContainerCreateOptions = {
      name: (info.Name || '').replace(/^\//, ''),
      Image: image,
      Cmd: info.Config?.Cmd ?? undefined,
      Env: mergedEnv,
      ExposedPorts: info.Config?.ExposedPorts ?? undefined,
      Labels: info.Config?.Labels ?? undefined,
      Tty: info.Config?.Tty ?? false,
      HostConfig: {
        PortBindings: info.HostConfig?.PortBindings ?? undefined,
        RestartPolicy: info.HostConfig?.RestartPolicy ?? undefined,
        Mounts: info.Mounts?.map((m) => ({
          Type: (m.Type as 'bind' | 'volume' | 'tmpfs') ?? 'volume',
          Source: m.Source ?? '',
          Target: m.Destination ?? '',
        })),
      },
      ...(networkNames.length > 0
        ? { NetworkingConfig: { EndpointsConfig: Object.fromEntries(networkNames.map((n) => [n, {}])) } }
        : {}),
    };

    // Remove old container (keep volumes) and recreate with merged env.
    await container.remove({ v: false });
    const newContainer = await docker.createContainer(createOpts);
    if (wasRunning) await newContainer.start();

    // The new container runs from the snapshot image — deleting it would
    // corrupt the container (it stays listed but all operations 404).
    // The snapshot outlives the container and becomes reclaimable by
    // prune_images after the container is removed.
    if (snapshotImage) {
      docker.getImage(snapshotImage).inspect().catch(() => {
        /* image exists check — no action needed */
      });
    }

    res.json({ id: newContainer.id, envUpdated: newEnv.map((e) => e.key), persisted: !!snapshotImage });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Search-and-replace text inside a container file. Reads the file, applies a
// literal search→replace, and writes it back.
containersRouter.post('/:id/files/replace', async (req: Request, res: Response) => {
  try {
    const target = String(req.body?.path ?? '');
    const rel = target.slice(1);
    if (!target.startsWith('/') || rel === '' || /\.\.(?:\/|$)/.test(target) || !/^[\w./-]+$/.test(rel)) {
      res.status(400).json({
        error: 'path must be an absolute file path using only letters, digits, "/", ".", "-", "_" (no "..").',
      });
      return;
    }
    const search = String(req.body?.search ?? '');
    if (!search) {
      res.status(400).json({ error: 'search string is required.' });
      return;
    }
    const replace = String(req.body?.replace ?? '');

    const container = docker.getContainer(req.params.id);
    const info = await container.inspect();
    if (info.Config?.Labels?.['iaas.system']) {
      res.status(403).json({ error: 'This container is system-managed and cannot be written to here.' });
      return;
    }
    if (!info.State?.Running) {
      res.status(409).json({ error: 'Container is not running — start it before replacing file content.' });
      return;
    }

    // Read the file via an exec'd cat.
    const readExec = await container.exec({
      Cmd: ['cat', target],
      AttachStdout: true,
      AttachStderr: true,
    });
    const readStream = await readExec.start({ hijack: true, stdin: false });
    const { output: currentContent, truncated } = await readExecOutput(readStream);
    const readResult = await readExec.inspect();
    if (readResult.ExitCode !== 0) {
      res.status(404).json({ error: `File not found or unreadable: ${currentContent.slice(0, 200)}` });
      return;
    }

    if (truncated) {
      res.status(413).json({
        error: `File exceeds the 256 KiB read limit for search-and-replace. Read the file manually and use write_container_file to replace it, or use execute_container_command with sed.`,
      });
      return;
    }

    const replaced = currentContent.split(search).join(replace);
    if (replaced === currentContent) {
      res.json({ path: target, replaced: false, reason: 'Search string not found in file.' });
      return;
    }

    // Write the modified content back.
    const buf = Buffer.from(replaced, 'utf8');
    const tarBuffer = await new Promise<Buffer>((resolve, reject) => {
      const pack = tar.pack();
      const chunks: Buffer[] = [];
      pack.on('data', (c: Buffer) => chunks.push(c));
      pack.on('end', () => resolve(Buffer.concat(chunks)));
      pack.on('error', reject);
      pack.entry({ name: rel, size: buf.length, mode: 0o644 }, buf);
      pack.finalize();
    });
    await container.putArchive(tarBuffer, { path: '/' });
    res.json({ path: target, replaced: true, occurrences: currentContent.split(search).length - 1 });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Bulk-write multiple text files into a running container in a single call.
containersRouter.post('/:id/files/bulk', async (req: Request, res: Response) => {
  try {
    const files: { path: string; content: string }[] = req.body?.files;
    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: 'files must be a non-empty array of { path, content }.' });
      return;
    }

    const container = docker.getContainer(req.params.id);
    const info = await container.inspect();
    if (info.Config?.Labels?.['iaas.system']) {
      res.status(403).json({ error: 'This container is system-managed and cannot be written to here.' });
      return;
    }
    if (!info.State?.Running) {
      res.status(409).json({ error: 'Container is not running — start it before writing files.' });
      return;
    }

    // Build a single tar with all files.
    const tarBuffer = await new Promise<Buffer>((resolve, reject) => {
      const pack = tar.pack();
      const chunks: Buffer[] = [];
      pack.on('data', (c: Buffer) => chunks.push(c));
      pack.on('end', () => resolve(Buffer.concat(chunks)));
      pack.on('error', reject);
      for (const file of files) {
        const rel = file.path.replace(/^\//, '');
        if (!rel || /\.\.(?:\/|$)/.test(file.path) || !/^[\w./-]+$/.test(rel)) {
          reject(new Error(`Invalid path: "${file.path}". Must be an absolute path using letters, digits, "/", ".", "-", "_" (no "..").`));
          return;
        }
        const buf = Buffer.from(file.content, 'utf8');
        pack.entry({ name: rel, size: buf.length, mode: 0o644 }, buf);
      }
      pack.finalize();
    });
    await container.putArchive(tarBuffer, { path: '/' });
    res.json({ ok: true, filesWritten: files.length });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Lifecycle actions -----------------------------------------------------------

async function lifecycle(
  id: string,
  action: 'start' | 'stop' | 'restart',
): Promise<void> {
  const c = docker.getContainer(id);
  if (action === 'start') await c.start();
  else if (action === 'stop') await c.stop();
  else await c.restart();
}

for (const action of ['start', 'stop', 'restart'] as const) {
  containersRouter.post(`/:id/${action}`, async (req: Request, res: Response) => {
    try {
      const container = docker.getContainer(req.params.id);
      const info = await container.inspect();
      if (info.Config?.Labels?.['iaas.system']) {
        res.status(403).json({ error: 'This container is system-managed and cannot be controlled here.' });
        return;
      }
      await lifecycle(req.params.id, action);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });
}

containersRouter.delete('/:id', async (req: Request, res: Response) => {
  const force = req.query.force === 'true';
  try {
    const container = docker.getContainer(req.params.id);
    const info = await container.inspect();
    if (info.Config?.Labels?.['iaas.system']) {
      res.status(403).json({ error: 'This container is system-managed and cannot be removed here.' });
      return;
    }
    await container.remove({ force, v: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Full container detail (inspect) for the drill-down panel.
containersRouter.get('/:id/inspect', async (req: Request, res: Response) => {
  try {
    const data = await docker.getContainer(req.params.id).inspect();
    const detail = {
      id: data.Id,
      name: (data.Name || '').replace(/^\//, ''),
      image: data.Config?.Image ?? '',
      state: data.State?.Status ?? 'unknown',
      status: data.State?.Status ?? '',
      created: new Date(data.Created).getTime() / 1000,
      ports: (data.NetworkSettings?.Ports
        ? Object.entries(data.NetworkSettings.Ports).flatMap(([key, bindings]) => {
            const [port, proto] = key.split('/');
            return (bindings || []).map((b) => ({
              privatePort: Number(port),
              publicPort: b?.HostPort ? Number(b.HostPort) : undefined,
              type: proto || 'tcp',
            }));
          })
        : []),
      env: data.Config?.Env ?? [],
      volumes: (data.Mounts || []).map((m) => ({
        source: m.Source ?? '',
        destination: m.Destination ?? '',
        mode: m.Mode ?? '',
        type: m.Type ?? 'volume',
      })),
      restartPolicy: data.HostConfig?.RestartPolicy?.Name ?? 'no',
      labels: data.Config?.Labels ?? {},
      sizeRw: (data as unknown as { SizeRw?: number }).SizeRw ?? 0,
      sizeRootFs: (data as unknown as { SizeRootFs?: number }).SizeRootFs ?? 0,
      description: data.Config?.Labels?.['iaas.description'] || undefined,
    };
    res.json(detail);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

containersRouter.get('/:id/logs', async (req: Request, res: Response) => {
  try {
    const buf = await docker.getContainer(req.params.id).logs({
      stdout: true,
      stderr: true,
      tail: Number(req.query.tail ?? 200),
      timestamps: false,
    });
    res.type('text/plain').send(stripLogHeaders(buf as unknown as Buffer));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/** Recursively list files in a container directory using `find`. */
export async function listContainerFiles(
  containerId: string,
  dirPath = '/',
  maxDepth = 4,
): Promise<{ path: string; entries: { type: string; name: string; size: number; mtime: number }[] }> {
  const absPath = typeof dirPath === 'string' && dirPath.startsWith('/')
    ? dirPath.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
    : '/';
  const depth = typeof maxDepth === 'number' && maxDepth >= 1 && maxDepth <= 8
    ? maxDepth : 4;

  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  if (info.Config?.Labels?.['iaas.system']) {
    throw new Error('System-managed containers cannot be listed by the assistant.');
  }
  if (info.Config?.Labels?.['iaas.assistant-managed'] !== 'true') {
    throw new Error('File listings are limited to containers created by the assistant.');
  }
  if (!info.State?.Running) {
    throw new Error('Container is not running.');
  }

  const exec = await container.exec({
    // BusyBox find (Alpine) lacks -printf, so we pair -exec stat with
    // -print.  Every matched entry produces a stat line then a path line.
    Cmd: [
      'find', absPath, '-maxdepth', String(depth),
      '(', '-type', 'f', '-o', '-type', 'd', ')',
      '-exec', 'stat', '-c', '%F\t%s\t%Y', '{}', ';',
      '-print',
    ],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const { output } = await readExecOutput(stream);

  const entries: { type: string; name: string; size: number; mtime: number }[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length - 1; i += 2) {
    const statLine = lines[i].trim();
    const pathLine = lines[i + 1].trim();
    if (!statLine || !pathLine) continue;
    const parts = statLine.split('\t');
    if (parts.length < 3) continue;
    const typeLabel = parts[0];   // "regular file", "directory", etc.
    const size = Number(parts[1]) || 0;
    const mtime = Number(parts[2]) || 0;
    // Strip the absPath prefix from the full path to get a relative name.
    const escapedPrefix = absPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const name = pathLine.replace(new RegExp(`^${escapedPrefix}/?`), '') || pathLine;
    if (!name || name === absPath || name.endsWith('/.')) continue;
    entries.push({
      type: typeLabel === 'directory' ? 'directory' : 'file',
      name: absPath === '/' ? `/${name}` : name.startsWith('/') ? name : `${absPath}/${name}`,
      size,
      mtime,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { path: absPath, entries };
}

// Recursively list files in a container directory.  Uses `find` under the
// hood with a configurable max depth (default 4).  Same security model as
// exec — only assistant-managed, non-system containers.
containersRouter.post('/:id/files/list', async (req: Request, res: Response) => {
  try {
    res.json(await listContainerFiles(
      req.params.id,
      req.body.path as string | undefined,
      req.body.maxDepth as number | undefined,
    ));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/** Probe an HTTP endpoint inside a container from Dockyard's own process
 *  (same Docker network).  Returns status, headers, and up to 4 KiB of body. */
export async function probeContainerEndpoint(
  containerId: string,
  port: number,
  path = '/',
  method = 'GET',
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string; truncated: boolean }> {
  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  if (!info.State?.Running) throw new Error('Container is not running.');
  const containerName = (info.Name || '').replace(/^\//, '');
  const target = `http://${containerName}:${port}${path}`;

  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const hreq = http.request(target, { method, timeout: 10_000 }, (hres) => {
      const chunks: Buffer[] = [];
      let size = 0;
      hres.on('data', (chunk: Buffer) => {
        if (size < 4096) { chunks.push(chunk); size += chunk.length; }
      });
      hres.on('end', () => {
        resolve({
          statusCode: hres.statusCode ?? 0,
          headers: hres.headers,
          body: Buffer.concat(chunks).toString('utf8').slice(0, 4096),
          truncated: size > 4096,
        });
      });
    });
    hreq.setTimeout(10_000, () => { hreq.destroy(); reject(new Error('Probe timed out after 10 seconds.')); });
    hreq.on('error', reject);
    hreq.end();
  });
}

// Probe endpoint — thin wrapper around probeContainerEndpoint.
containersRouter.post('/:id/probe', async (req: Request, res: Response) => {
  try {
    res.json(await probeContainerEndpoint(
      req.params.id,
      typeof req.body.port === 'number' ? req.body.port : Number(req.body.port) || 80,
      typeof req.body.path === 'string' ? req.body.path : '/',
      typeof req.body.method === 'string' ? req.body.method.toUpperCase() : 'GET',
    ));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Non-TTY container logs are multiplexed with an 8-byte header per frame.
export function stripLogHeaders(buf: Buffer): string {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + len;
    if (end > buf.length) break;
    out.push(buf.subarray(start, end));
    offset = end;
  }
  if (out.length === 0) return buf.toString('utf8');
  return Buffer.concat(out).toString('utf8');
}
