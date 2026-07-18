import { Router, type Request, type Response } from 'express';
import type Docker from 'dockerode';
import tar from 'tar-stream';
import { docker, dockyardNetworkConfig, ensureImage } from '../docker.js';
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
  };
}

// List all containers, including sizes (size=true) so the UI can show per-
// instance disk footprint next to the fleet-wide totals.
containersRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const list = await docker.listContainers({ all: true, size: true });
    res.json(list.map(toView));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

interface LaunchBody {
  presetId?: string;
  image?: string;
  name?: string;
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
containersRouter.post('/:id/exec', async (req: Request, res: Response) => {
  const { command, workingDir, background } = req.body as Record<string, unknown>;
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
      AttachStdout: !background,
      AttachStderr: !background,
      WorkingDir: workingDir,
    });

    if (background) {
      await exec.start({ hijack: false, stdin: false });
      res.json({
        command: commandArgs,
        workingDir: workingDir ?? null,
        background: true,
        execId: exec.id,
      });
      return;
    }

    const stream = await exec.start({ hijack: true, stdin: false });
    const { output, truncated } = await readExecOutput(stream);
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

// Update environment variables on a container. Docker doesn't support mutating
// env on a running container, so this stops → snapshots config → removes
// (keeping volumes) → recreates with merged env → starts.
containersRouter.post('/:id/env', async (req: Request, res: Response) => {
  const { env: newEnv } = req.body as { env?: { key: string; value: string }[] };
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

    // Merge old env with new env — new keys overwrite old ones.
    const oldEnv: Record<string, string> = {};
    for (const e of info.Config?.Env ?? []) {
      const idx = e.indexOf('=');
      if (idx > 0) oldEnv[e.slice(0, idx)] = e.slice(idx + 1);
    }
    for (const e of newEnv) oldEnv[e.key] = e.value;
    const mergedEnv = Object.entries(oldEnv).map(([k, v]) => `${k}=${v}`);

    // Snapshot the existing config we need to preserve.
    const createOpts: Docker.ContainerCreateOptions = {
      name: (info.Name || '').replace(/^\//, ''),
      Image: info.Config?.Image ?? '',
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
    };

    // Remove old container (keep volumes) and recreate with merged env.
    await container.remove({ v: false });
    const newContainer = await docker.createContainer(createOpts);
    if (wasRunning) await newContainer.start();

    res.json({ id: newContainer.id, envUpdated: newEnv.map((e) => e.key) });
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
    const { output: currentContent } = await readExecOutput(readStream);
    const readResult = await readExec.inspect();
    if (readResult.ExitCode !== 0) {
      res.status(404).json({ error: `File not found or unreadable: ${currentContent.slice(0, 200)}` });
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
