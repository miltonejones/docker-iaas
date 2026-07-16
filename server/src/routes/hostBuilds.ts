import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import tar from 'tar-stream';
import { docker } from '../docker.js';

export const hostBuildsRouter = Router();

const MAX_ARTIFACT_SIZE = 200 * 1024 * 1024;
const MAX_HELPER_RESPONSE = 128 * 1024;

interface CommandPreset {
  name: string;
  cwd: string;
  command: string;
  args: string[];
  artifacts: string;
}

export function listHostBuildPresets(): CommandPreset[] {
  const raw = process.env.HOST_COMMAND_PRESETS || '[]';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('HOST_COMMAND_PRESETS must be valid JSON.');
  }
  if (!Array.isArray(parsed)) throw new Error('HOST_COMMAND_PRESETS must be a JSON array.');
  return parsed.map((item): CommandPreset => {
    const preset = item as Partial<CommandPreset>;
    if (
      !/^[a-z0-9][a-z0-9-]*$/.test(preset.name ?? '') ||
      !path.isAbsolute(preset.cwd ?? '') ||
      !preset.command ||
      !Array.isArray(preset.args) ||
      !preset.args.every((arg) => typeof arg === 'string') ||
      !preset.artifacts ||
      path.isAbsolute(preset.artifacts) ||
      preset.artifacts.split('/').includes('..')
    ) {
      throw new Error('Each command preset needs name, absolute cwd, command, string args, and relative artifacts.');
    }
    return preset as CommandPreset;
  });
}

function resolveHostDirectory(cwd: string, artifacts: string): string {
  const hostRoot = path.resolve(process.env.HOST_DISK_PATH || '/');
  const hostCwd = path.resolve(hostRoot, `.${cwd}`);
  const artifactDirectory = path.resolve(hostCwd, artifacts);
  if (path.relative(hostCwd, artifactDirectory).startsWith('..')) {
    throw new Error('Preset artifact path must stay within its working directory.');
  }
  return artifactDirectory;
}

function containerPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/')) return undefined;
  const relative = value.slice(1);
  if (!relative || /\.\.(?:\/|$)/.test(relative) || !/^[\w./-]+$/.test(relative)) return undefined;
  return value;
}

async function directoryArchive(directory: string): Promise<{ archive: Buffer; size: number }> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  let totalSize = 0;
  pack.on('data', (chunk: Buffer) => chunks.push(chunk));
  const completion = new Promise<Buffer>((resolve, reject) => {
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);
  });

  async function addDirectory(current: string, relative: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(current, entry.name);
      const target = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        pack.entry({ name: target, type: 'directory', mode: 0o755 });
        await addDirectory(source, target);
      } else if (entry.isFile()) {
        const content = await fs.readFile(source);
        totalSize += content.length;
        if (totalSize > MAX_ARTIFACT_SIZE) {
          throw new Error('Build artifacts exceed the 200 MiB transfer limit.');
        }
        pack.entry({ name: target, size: content.length, mode: 0o644 }, content);
      } else {
        throw new Error(`Artifact "${target}" is not a regular file or directory.`);
      }
    }
  }

  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) throw new Error('Configured artifact path is not a directory.');
  await addDirectory(directory, '');
  pack.finalize();
  return { archive: await completion, size: totalSize };
}

async function runHelper(preset: string): Promise<void> {
  const socketPath = process.env.HOST_BUILD_HELPER_SOCKET || '/tmp/dockyard-host-build.sock';
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10 * 60 * 1000);
    socket.on('connect', () => socket.end(`${JSON.stringify({ preset })}\n`));
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.length > MAX_HELPER_RESPONSE) socket.destroy(new Error('Host build helper response is too large.'));
    });
    socket.on('timeout', () => socket.destroy(new Error('Host build helper timed out.')));
    socket.on('error', reject);
    socket.on('end', () => {
      try {
        const result = JSON.parse(response) as { ok: boolean; error?: string };
        if (!result.ok) throw new Error(result.error || 'Host build helper failed.');
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

hostBuildsRouter.get('/presets', (_req: Request, res: Response) => {
  try {
    res.json(listHostBuildPresets().map(({ name, cwd, command, args, artifacts }) => ({ name, cwd, command, args, artifacts })));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

hostBuildsRouter.post('/run', async (req: Request, res: Response) => {
  const { preset: name, id, path: destinationPath } = req.body as Record<string, unknown>;
  const destination = containerPath(destinationPath);
  if (typeof name !== 'string' || typeof id !== 'string' || !destination) {
    res.status(400).json({ error: 'preset, id, and a valid absolute destination path are required.' });
    return;
  }

  try {
    const preset = listHostBuildPresets().find((item) => item.name === name);
    if (!preset) {
      res.status(404).json({ error: `Build preset "${name}" is not configured.` });
      return;
    }
    const container = docker.getContainer(id);
    const info = await container.inspect();
    if (info.Config?.Labels?.['iaas.system']) {
      res.status(403).json({ error: 'This container is system-managed and cannot receive build artifacts.' });
      return;
    }
    if (!info.State?.Running) {
      res.status(409).json({ error: 'Container is not running — start it before deploying build artifacts.' });
      return;
    }

    await runHelper(preset.name);
    const artifacts = await directoryArchive(resolveHostDirectory(preset.cwd, preset.artifacts));
    await container.putArchive(artifacts.archive, { path: destination });
    res.json({ ok: true, preset: preset.name, id, path: destination, size: artifacts.size });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
