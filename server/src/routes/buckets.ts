import { Router, type Request, type Response } from 'express';
import express from 'express';
import {
  ListBucketsCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getS3Client } from '../minio.js';

export const bucketsRouter = Router();

// Sum every object's Size in a bucket by paginating ListObjectsV2.
// ListBuckets doesn't report size, so the list view needs this to populate a
// Size column. MinIO is local, so the N+1 walk is cheap for the demo scale.
async function bucketStats(name: string): Promise<{ size: number; objectCount: number }> {
  let size = 0;
  let objectCount = 0;
  let token: string | undefined;
  do {
    const out = await getS3Client().send(
      new ListObjectsV2Command({ Bucket: name, ContinuationToken: token }),
    );
    for (const o of out.Contents || []) {
      size += o.Size ?? 0;
      objectCount += 1;
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return { size, objectCount };
}

bucketsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const out = await getS3Client().send(new ListBucketsCommand({}));
    const withStats = await Promise.all(
      (out.Buckets || []).map(async (b) => {
        try {
          const { size, objectCount } = await bucketStats(b.Name!);
          return { name: b.Name, creationDate: b.CreationDate, size, objectCount };
        } catch {
          return { name: b.Name, creationDate: b.CreationDate, size: 0, objectCount: 0 };
        }
      }),
    );
    res.json(withStats);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

bucketsRouter.post('/', express.json(), async (req: Request, res: Response) => {
  const name = (req.body?.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'A bucket name is required.' });
    return;
  }
  try {
    await getS3Client().send(new CreateBucketCommand({ Bucket: name }));
    res.status(201).json({ name });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

bucketsRouter.delete('/:name', async (req: Request, res: Response) => {
  try {
    await getS3Client().send(new DeleteBucketCommand({ Bucket: req.params.name }));
    res.json({ ok: true });
  } catch (err) {
    const code = (err as { Code?: string; name?: string }).Code || (err as Error).name;
    if (code === 'BucketNotEmpty') {
      res.status(409).json({ error: 'Bucket is not empty — delete its objects first.' });
      return;
    }
    res.status(502).json({ error: (err as Error).message });
  }
});

bucketsRouter.get('/:name/objects', async (req: Request, res: Response) => {
  const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
  try {
    const out = await getS3Client().send(
      new ListObjectsV2Command({ Bucket: req.params.name, Prefix: prefix, Delimiter: '/' }),
    );
    res.json({
      prefixes: (out.CommonPrefixes || []).map((p) => p.Prefix).filter(Boolean),
      objects: (out.Contents || [])
        .filter((o) => o.Key !== prefix)
        .map((o) => ({
          key: o.Key,
          size: o.Size ?? 0,
          lastModified: o.LastModified,
        })),
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

bucketsRouter.put(
  '/:name/objects/*',
  express.raw({ type: '*/*', limit: '200mb' }),
  async (req: Request, res: Response) => {
    const key = req.params[0];
    if (!key) {
      res.status(400).json({ error: 'An object key is required.' });
      return;
    }
    try {
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: req.params.name,
          Key: key,
          Body: req.body,
          ContentType: req.get('content-type') || 'application/octet-stream',
        }),
      );
      res.status(201).json({ key });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  },
);

bucketsRouter.get('/:name/objects/*', async (req: Request, res: Response) => {
  const key = req.params[0];
  try {
    const out = await getS3Client().send(new GetObjectCommand({ Bucket: req.params.name, Key: key }));
    res.set('Content-Type', out.ContentType || 'application/octet-stream');
    if (out.ContentLength != null) res.set('Content-Length', String(out.ContentLength));
    res.set('Content-Disposition', `attachment; filename="${key.split('/').pop()}"`);
    (out.Body as NodeJS.ReadableStream).pipe(res);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

bucketsRouter.delete('/:name/objects/*', async (req: Request, res: Response) => {
  const key = req.params[0];
  try {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: req.params.name, Key: key }));
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});
