import type Docker from 'dockerode';
import tar from 'tar-stream';
import { docker, dockyardNetworkConfig, ensureImage } from '../docker.js';
import { findPreset } from '../presets.js';
import { recordAuditLog } from '../db/audit.js';
import { getProject } from '../db.js';
import { HttpError } from './HttpError.js';
import type { ContainerView, LaunchInput, EnvUpdateInput, ExecInput, ExecResult, BackgroundExecResult, ProbeResult, WriteFileInput, ReplaceInput, ReplaceResult } from './types.js';

// ── Helpers ───────────────────────────────────────────────────

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
    projectId: c.Labels?.['iaas.project_id'] || undefined,
    system: !!c.Labels?.['iaas.system'],
    protected: !!c.Labels?.['iaas.protected'],
    description: c.Labels?.['iaas.description'] || undefined,
  };
}

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

async function lifecycle(id: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
  const c = docker.getContainer(id);
  if (action === 'start') await c.start();
  else if (action === 'stop') await c.stop();
  else await c.restart();
}

// ── Module-scoped state ───────────────────────────────────────

export const backgroundExecOutputs = new Map<string, { output: string; exitCode: number | null; truncated: boolean }>();

// ── Service functions ─────────────────────────────────────────

export async function list(userId?: string, projectId?: string): Promise<ContainerView[]> {
  const listRaw = await docker.listContainers({ all: true, size: true });
  const withoutEphemeral = listRaw.filter((c) => !c.Labels?.['iaas.ephemeral']);
  let filtered = userId
    ? withoutEphemeral.filter((c) => {
        const owner = c.Labels?.['iaas.owner'];
        const system = c.Labels?.['iaas.system'];
        return system || owner === userId || !owner;
      })
    : withoutEphemeral;
  if (projectId) {
    filtered = filtered.filter((c) => c.Labels?.['iaas.project_id'] === projectId);
  }
  return filtered.map(toView);
}

export async function launch(userId: string | undefined, input: LaunchInput): Promise<{ id: string }> {
  const preset = input.presetId ? findPreset(input.presetId) : undefined;
  const image = input.image || preset?.image;
  if (!image) {
    throw new HttpError(400, 'An image or a valid presetId is required.');
  }

  if (input.projectId?.trim()) {
    const project = getProject(input.projectId.trim(), userId);
    if (!project) throw new HttpError(400, 'Project not found.');
  }

  await ensureImage(image);

  const exposedPorts: Record<string, {}> = {};
  const portBindings: Record<string, { HostPort: string }[]> = {};
  for (const p of input.ports ?? []) {
    const key = p.container.includes('/') ? p.container : `${p.container}/tcp`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostPort: String(p.host) }];
  }

  const env = (input.env ?? [])
    .filter((e) => e.key)
    .map((e) => `${e.key}=${e.value}`);

  const volumePaths = input.volumes ?? preset?.volumes ?? [];
  const containerName = input.name || `${preset?.id ?? 'container'}-${Math.random().toString(36).slice(2, 8)}`;
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

  const needsTty = !input.command && preset
    ? ['ubuntu', 'debian', 'alpine', 'fedora', 'rockylinux', 'archlinux', 'node', 'python'].includes(preset.id)
    : false;

  const container = await docker.createContainer({
    Image: image,
    name: input.name || undefined,
    Cmd: input.command,
    Env: env.length ? env : undefined,
    ExposedPorts: Object.keys(exposedPorts).length ? exposedPorts : undefined,
    Labels: {
      ...(preset ? { 'iaas.preset': preset.id } : {}),
      ...(input.assistantManaged ? { 'iaas.assistant-managed': 'true' } : {}),
      ...(userId ? { 'iaas.owner': userId } : {}),
      ...(input.description?.trim() ? { 'iaas.description': input.description.trim() } : {}),
      ...(input.protected ? { 'iaas.protected': 'true' } : {}),
      ...(input.projectId?.trim() ? { 'iaas.project_id': input.projectId.trim() } : {}),
    },
    Tty: needsTty,
    HostConfig: {
      PortBindings: Object.keys(portBindings).length ? portBindings : undefined,
      RestartPolicy: { Name: 'unless-stopped' },
      Mounts: mounts,
    },
    ...dockyardNetworkConfig(),
  });

  if (input.autoStart !== false) {
    await container.start();
  }
  return { id: container.id };
}

export async function start(id: string, userId?: string): Promise<void> {
  const container = docker.getContainer(id);
  const info = await container.inspect();
  if (info.Config?.Labels?.['iaas.system']) throw new HttpError(403, 'This container is system-managed and cannot be controlled here.');
  if (info.Config?.Labels?.['iaas.protected']) throw new HttpError(403, 'This container is protected — unprotect it before starting, stopping, or restarting.');
  await lifecycle(id, 'start');
}

export async function stop(id: string, userId?: string): Promise<void> {
  const container = docker.getContainer(id);
  const info = await container.inspect();
  if (info.Config?.Labels?.['iaas.system']) throw new HttpError(403, 'This container is system-managed and cannot be controlled here.');
  if (info.Config?.Labels?.['iaas.protected']) throw new HttpError(403, 'This container is protected — unprotect it before starting, stopping, or restarting.');
  await lifecycle(id, 'stop');
}

export async function restart(id: string, userId?: string): Promise<void> {
  const container = docker.getContainer(id);
  const info = await container.inspect();
  if (info.Config?.Labels?.['iaas.system']) throw new HttpError(403, 'This container is system-managed and cannot be controlled here.');
  if (info.Config?.Labels?.['iaas.protected']) throw new HttpError(403, 'This container is protected — unprotect it before starting, stopping, or restarting.');
  await lifecycle(id, 'restart');
}

export async function remove(id: string, userId?: string, force?: boolean): Promise<void> {
  const container = docker.getContainer(id);
  const info = await container.inspect();
  if (info.Config?.Labels?.['iaas.system']) throw new HttpError(403, 'This container is system-managed and cannot be removed here.');
  if (info.Config?.Labels?.['iaas.protected']) throw new HttpError(403, 'This container is protected — unprotect it before removing.');
  await container.remove({ force: !!force, v: true });
  recordAuditLog('container.delete', 'container', id, null, null);
}

export async function inspect(id: string) {
  const data = await docker.getContainer(id).inspect();
  return {
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
    protected: !!data.Config?.Labels?.['iaas.protected'],
  };
}

export async function logs(id: string, tail?: number): Promise<string> {
  const buf = await docker.getContainer(id).logs({
    stdout: true,
    stderr: true,
    tail: tail ?? 200,
    timestamps: false,
  });
  return stripLogHeaders(buf as unknown as Buffer);
}

export async function updateEnv(id: string, userId: string | undefined, input: EnvUpdateInput) {
  const { env: newEnv, persist, description, protected: nextProtected, projectId } = input;
  const hasEnvUpdate = Array.isArray(newEnv) && newEnv.length > 0;
  const hasDescriptionUpdate = typeof description === 'string';
  const hasProtectedUpdate = typeof nextProtected === 'boolean';
  const hasProjectIdUpdate = projectId !== undefined;
  if (!hasEnvUpdate && !hasDescriptionUpdate && !hasProtectedUpdate && !hasProjectIdUpdate) {
    throw new HttpError(400, 'Provide a non-empty env array of { key, value }, a description string, a protected boolean, and/or a projectId.');
  }
  if (hasEnvUpdate) {
    for (const e of newEnv!) {
      if (typeof e.key !== 'string' || !e.key || typeof e.value !== 'string') {
        throw new HttpError(400, 'Each env entry needs a non-empty string key and a string value.');
      }
    }
  }

  let snapshotImage: string | null = null;

  const container = docker.getContainer(id);
  const info = await container.inspect();
  if (info.Config?.Labels?.['iaas.system']) {
    throw new HttpError(403, 'System-managed containers cannot be updated here.');
  }

  const wasRunning = info.State?.Running ?? false;
  if (wasRunning) await container.stop();

  let image = info.Config?.Image ?? '';
  if (persist) {
    snapshotImage = `dockyard-snapshot-${id}-${Date.now()}`;
    await container.commit({ repo: snapshotImage });
    image = snapshotImage;
  }

  const oldEnv: Record<string, string> = {};
  for (const e of info.Config?.Env ?? []) {
    const idx = e.indexOf('=');
    if (idx > 0) oldEnv[e.slice(0, idx)] = e.slice(idx + 1);
  }
  if (hasEnvUpdate) for (const e of newEnv!) oldEnv[e.key] = e.value;
  const mergedEnv = Object.entries(oldEnv).map(([k, v]) => `${k}=${v}`);

  const mergedLabels: Record<string, string> = { ...(info.Config?.Labels ?? {}) };
  if (hasDescriptionUpdate) {
    const trimmed = description!.trim();
    if (trimmed) mergedLabels['iaas.description'] = trimmed;
    else delete mergedLabels['iaas.description'];
  }
  if (hasProtectedUpdate) {
    if (nextProtected) mergedLabels['iaas.protected'] = 'true';
    else delete mergedLabels['iaas.protected'];
  }
  if (hasProjectIdUpdate) {
    if (projectId) mergedLabels['iaas.project_id'] = projectId;
    else delete mergedLabels['iaas.project_id'];
  }

  const networks = info.NetworkSettings?.Networks ?? {};
  const networkNames = Object.keys(networks);
  const createOpts: Docker.ContainerCreateOptions = {
    name: (info.Name || '').replace(/^\//, ''),
    Image: image,
    Cmd: info.Config?.Cmd ?? undefined,
    Env: mergedEnv,
    ExposedPorts: info.Config?.ExposedPorts ?? undefined,
    Labels: mergedLabels,
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

  await container.remove({ v: false });
  const newContainer = await docker.createContainer(createOpts);
  if (wasRunning) await newContainer.start();

  if (snapshotImage) {
    docker.getImage(snapshotImage).inspect().catch(() => {});
  }

  recordAuditLog('container.env.update', 'container', id, null, hasEnvUpdate ? newEnv!.map((e) => e.key).join(',') : null);
  return {
    id: newContainer.id,
    envUpdated: hasEnvUpdate ? newEnv!.map((e) => e.key) : [],
    descriptionUpdated: hasDescriptionUpdate,
    description: mergedLabels['iaas.description'],
    protectedUpdated: hasProtectedUpdate,
    protected: !!mergedLabels['iaas.protected'],
    persisted: !!snapshotImage,
  };
}

export async function execCommand(
  id: string,
  userId: string | undefined,
  input: ExecInput & { background?: boolean },
): Promise<ExecResult | BackgroundExecResult> {
  const { command, workingDir, background, timeoutSeconds } = input;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.length > 32 ||
    command.some((part) => typeof part !== 'string' || !part || part.length > 4096)
  ) {
    throw new HttpError(400, 'command must be a non-empty array of up to 32 non-empty string arguments.');
  }
  if (
    workingDir !== undefined &&
    (typeof workingDir !== 'string' ||
      !workingDir.startsWith('/') ||
      /\.\.(?:\/|$)/.test(workingDir) ||
      workingDir.length > 4096)
  ) {
    throw new HttpError(400, 'workingDir must be an absolute container path without "..".');
  }
  const timeout = typeof timeoutSeconds === 'number' && timeoutSeconds >= 1 && timeoutSeconds <= 600
    ? timeoutSeconds * 1000 : undefined;

  const container = docker.getContainer(id);
  const info = await container.inspect();
  if (info.Config?.Labels?.['iaas.system']) {
    throw new HttpError(403, 'System-managed containers cannot execute assistant commands.');
  }
  if (info.Config?.Labels?.['iaas.assistant-managed'] !== 'true') {
    throw new HttpError(403, 'Assistant commands are limited to containers created by the assistant.');
  }
  if (!info.State?.Running) {
    throw new HttpError(409, 'Container is not running — start it before executing a command.');
  }

  const exec = await container.exec({
    Cmd: command,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: workingDir,
  });

  if (background) {
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
      setTimeout(() => backgroundExecOutputs.delete(execId), 5 * 60_000);
    })();

    recordAuditLog('container.exec', 'container', id, userId, command[0]);
    return { command, workingDir: workingDir ?? null, execId };
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
    if (!result.ok) throw new HttpError(504, result.error);
    output = result.output;
    truncated = result.truncated;
  } else {
    ({ output, truncated } = await outputPromise);
  }

  const result = await exec.inspect();
  recordAuditLog('container.exec', 'container', id, userId, command[0]);
  return { command, workingDir: workingDir ?? null, exitCode: result.ExitCode ?? null, output, truncated };
}

export function getExecOutput(execId: string) {
  return backgroundExecOutputs.get(execId) || null;
}

export async function writeFile(id: string, userId: string | undefined, input: WriteFileInput): Promise<{ ok: true; path: string }> {
  const target = String(input.path ?? '');
  const rel = target.slice(1);
  if (!target.startsWith('/') || rel === '' || /\.\.(?:\/|$)/.test(target) || !/^[\w./-]+$/.test(rel)) {
    throw new HttpError(400, 'path must be an absolute file path using only letters, digits, "/", ".", "-", "_" (no "..").');
  }
  const content = String(input.content ?? '');

  const container = docker.getContainer(id);
  const info = await container.inspect();
  if (info.Config?.Labels?.['iaas.system']) throw new HttpError(403, 'This container is system-managed and cannot be written to here.');
  if (!info.State?.Running) throw new HttpError(409, 'Container is not running — start it before writing files.');

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
  recordAuditLog('container.files.write', 'container', id, userId, target);
  return { ok: true, path: target };
}

export async function writeFiles(id: string, userId: string | undefined, files: WriteFileInput[]): Promise<{ ok: true; filesWritten: number }> {
  if (!Array.isArray(files) || files.length === 0) {
    throw new HttpError(400, 'files must be a non-empty array of { path, content }.');
  }

  const container = docker.getContainer(id);
  const info = await container.inspect();
  if (info.Config?.Labels?.['iaas.system']) throw new HttpError(403, 'This container is system-managed and cannot be written to here.');
  if (!info.State?.Running) throw new HttpError(409, 'Container is not running — start it before writing files.');

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
  recordAuditLog('container.files.bulk_write', 'container', id, null, String(files.length));
  return { ok: true, filesWritten: files.length };
}

export async function replaceInFile(id: string, userId: string | undefined, input: ReplaceInput): Promise<ReplaceResult> {
  const target = String(input.path ?? '');
  const rel = target.slice(1);
  if (!target.startsWith('/') || rel === '' || /\.\.(?:\/|$)/.test(target) || !/^[\w./-]+$/.test(rel)) {
    throw new HttpError(400, 'path must be an absolute file path using only letters, digits, "/", ".", "-", "_" (no "..").');
  }
  const search = String(input.search ?? '');
  if (!search) throw new HttpError(400, 'search string is required.');
  const replace = String(input.replace ?? '');

  const container = docker.getContainer(id);
  const info = await container.inspect();
  if (info.Config?.Labels?.['iaas.system']) throw new HttpError(403, 'This container is system-managed and cannot be written to here.');
  if (!info.State?.Running) throw new HttpError(409, 'Container is not running — start it before replacing file content.');

  const readExec = await container.exec({
    Cmd: ['cat', target],
    AttachStdout: true,
    AttachStderr: true,
  });
  const readStream = await readExec.start({ hijack: true, stdin: false });
  const { output: currentContent, truncated } = await readExecOutput(readStream);
  const readResult = await readExec.inspect();
  if (readResult.ExitCode !== 0) {
    throw new HttpError(404, `File not found or unreadable: ${currentContent.slice(0, 200)}`);
  }
  if (truncated) {
    throw new HttpError(413, 'File exceeds the 256 KiB read limit for search-and-replace.');
  }

  const replaced = currentContent.split(search).join(replace);
  if (replaced === currentContent) {
    throw new HttpError(404, 'Search string not found in file.');
  }

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
  recordAuditLog('container.files.replace', 'container', id, null, target);
  return { replacements: currentContent.split(search).length - 1, content: replaced };
}

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
  if (info.Config?.Labels?.['iaas.system']) throw new Error('System-managed containers cannot be listed by the assistant.');
  if (info.Config?.Labels?.['iaas.assistant-managed'] !== 'true') throw new Error('File listings are limited to containers created by the assistant.');
  if (!info.State?.Running) throw new Error('Container is not running.');

  const exec = await container.exec({
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
    const typeLabel = parts[0];
    const size = Number(parts[1]) || 0;
    const mtime = Number(parts[2]) || 0;
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

export async function probeContainerEndpoint(
  containerId: string,
  port: number,
  path = '/',
  method = 'GET',
): Promise<ProbeResult> {
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
          headers: hres.headers as Record<string, string | string[] | undefined>,
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
