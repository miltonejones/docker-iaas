import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import tar from 'tar-stream';
import { docker } from '../docker.js';
import { getS3Client } from '../minio.js';

export const hostFilesRouter = Router();

const MAX_FILE_SIZE = 200 * 1024 * 1024;
const MAX_ASSISTANT_FILE_BYTES = 512 * 1024;
const MAX_ASSISTANT_FILE_CHARS = 50_000;
const MAX_DIRECTORY_ENTRIES = 500;
const SENSITIVE_PATH_SEGMENTS = new Set([
  '.aws',
  '.docker',
  '.gnupg',
  '.kube',
  '.password-store',
  '.ssh',
  'secrets',
]);

export function isSensitiveAssistantPath(sourcePath: unknown): boolean {
  if (typeof sourcePath !== 'string') return false;
  const segments = sourcePath.split('/').filter(Boolean).map((segment) => segment.toLowerCase());
  const name = segments.at(-1) || '';
  return (
    segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment)) ||
    name === '.antro' ||
    name === '.dockyard_database_master_key' ||
    name === '.env' ||
    name.startsWith('.env.') ||
    /^id_[a-z0-9_-]+$/.test(name) ||
    /^(credentials|passwords?)$/.test(name) ||
    /\.(key|pem|p12|pfx)$/i.test(name)
  );
}

export function containsLikelySecret(content: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content) ||
    /\b(?:api[_-]?key|password|secret|token)\b\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/i.test(content)
  );
}

export async function resolveHostPath(sourcePath: unknown): Promise<string> {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
    throw new Error('sourcePath must be an absolute host file path.');
  }

  // HOST_DISK_PATH is "/" when running directly on the host and "/host" when
  // Dockyard runs in Docker. Prefixing with "." prevents the absolute source
  // path from replacing that configured root.
  const hostRoot = path.resolve(process.env.HOST_DISK_PATH || '/');
  const resolved = path.resolve(hostRoot, `.${sourcePath}`);
  if (path.relative(hostRoot, resolved).startsWith('..')) {
    throw new Error('sourcePath must stay within the mounted host filesystem.');
  }
  const [realRoot, realPath] = await Promise.all([fs.realpath(hostRoot), fs.realpath(resolved)]);
  if (path.relative(realRoot, realPath).startsWith('..')) {
    throw new Error('sourcePath must stay within the mounted host filesystem.');
  }
  return realPath;
}

async function readHostFile(sourcePath: unknown): Promise<{ sourcePath: string; content: Buffer }> {
  const resolved = await resolveHostPath(sourcePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error('sourcePath must identify a regular file.');
  }
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error('sourcePath exceeds the 200 MiB transfer limit.');
  }
  return { sourcePath: resolved, content: await fs.readFile(resolved) };
}

export async function listHostDirectory(sourcePath: unknown) {
  if (isSensitiveAssistantPath(sourcePath)) {
    throw new Error('Assistant access to sensitive host paths is not allowed.');
  }
  const resolved = await resolveHostPath(sourcePath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error('sourcePath must identify a directory.');
  }

  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const visible = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_DIRECTORY_ENTRIES);
  return {
    path: sourcePath,
    entries: await Promise.all(
      visible.map(async (entry) => {
        const entryPath = path.join(resolved, entry.name);
        const entryStat = await fs.lstat(entryPath);
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
          size: entry.isFile() ? entryStat.size : undefined,
          modifiedAt: entryStat.mtime.toISOString(),
        };
      }),
    ),
    truncated: entries.length > MAX_DIRECTORY_ENTRIES,
  };
}

export async function readHostTextFile(sourcePath: unknown) {
  if (isSensitiveAssistantPath(sourcePath)) {
    throw new Error('Assistant access to sensitive host paths is not allowed.');
  }
  const resolved = await resolveHostPath(sourcePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error('sourcePath must identify a regular file.');
  }
  if (stat.size > MAX_ASSISTANT_FILE_BYTES) {
    throw new Error(`sourcePath exceeds the ${MAX_ASSISTANT_FILE_BYTES / 1024} KiB assistant read limit.`);
  }

  const content = await fs.readFile(resolved);
  if (content.includes(0)) {
    throw new Error('sourcePath appears to be binary and cannot be read as text.');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  if (containsLikelySecret(text)) {
    throw new Error('sourcePath appears to contain credentials or private-key material and cannot be read by the assistant.');
  }
  return {
    path: sourcePath,
    content: text.length > MAX_ASSISTANT_FILE_CHARS ? text.slice(0, MAX_ASSISTANT_FILE_CHARS) : text,
    truncated: text.length > MAX_ASSISTANT_FILE_CHARS,
  };
}

export function validContainerPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/')) return undefined;
  const relative = value.slice(1);
  if (!relative || /\.\.(?:\/|$)/.test(relative) || !/^[\w./-]+$/.test(relative)) return undefined;
  return relative;
}

async function archiveFile(relativePath: string, content: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on('data', (chunk: Buffer) => chunks.push(chunk));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);
    pack.entry({ name: relativePath, size: content.length, mode: 0o644 }, content);
    pack.finalize();
  });
}

hostFilesRouter.post('/to-bucket', async (req: Request, res: Response) => {
  const { sourcePath, bucket, key, contentType } = req.body as Record<string, unknown>;
  if (typeof bucket !== 'string' || !bucket || typeof key !== 'string' || !key) {
    res.status(400).json({ error: 'bucket and key are required.' });
    return;
  }

  try {
    const file = await readHostFile(sourcePath);
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.content,
        ContentType: typeof contentType === 'string' && contentType ? contentType : 'application/octet-stream',
      }),
    );
    res.status(201).json({ bucket, key, size: file.content.length });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

hostFilesRouter.post('/to-container', async (req: Request, res: Response) => {
  const { sourcePath, id, path: destinationPath } = req.body as Record<string, unknown>;
  const relativePath = validContainerPath(destinationPath);
  if (typeof id !== 'string' || !id || !relativePath) {
    res.status(400).json({
      error: 'id and an absolute destination path using only letters, digits, "/", ".", "-", "_" (no "..") are required.',
    });
    return;
  }

  try {
    const container = docker.getContainer(id);
    const info = await container.inspect();
    if (info.Config?.Labels?.['iaas.system']) {
      res.status(403).json({ error: 'This container is system-managed and cannot be written to here.' });
      return;
    }
    if (!info.State?.Running) {
      res.status(409).json({ error: 'Container is not running — start it before copying files.' });
      return;
    }

    const file = await readHostFile(sourcePath);
    await container.putArchive(await archiveFile(relativePath, file.content), { path: '/' });
    res.json({ ok: true, id, path: destinationPath, size: file.content.length });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
