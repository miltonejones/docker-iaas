import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import tar from 'tar-stream';
import { docker } from '../docker.js';
import { getS3Client } from '../minio.js';

export const hostFilesRouter = Router();

const MAX_FILE_SIZE = 200 * 1024 * 1024;

function resolveHostPath(sourcePath: unknown): string {
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
  return resolved;
}

async function readHostFile(sourcePath: unknown): Promise<{ sourcePath: string; content: Buffer }> {
  const resolved = resolveHostPath(sourcePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error('sourcePath must identify a regular file.');
  }
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error('sourcePath exceeds the 200 MiB transfer limit.');
  }
  return { sourcePath: resolved, content: await fs.readFile(resolved) };
}

function validContainerPath(value: unknown): string | undefined {
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
