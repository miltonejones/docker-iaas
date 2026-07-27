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
import {
  setBucketOwner,
  getBucketOwner,
  listUserBuckets,
  isBucketProtected,
  setBucketProtected,
  getBucketProjectId,
} from '../db.js';
import { HttpError } from './HttpError.js';
import type { BucketView, ObjectList, WriteObjectInput, ReplaceResult } from './types.js';

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

export { bucketStats };

export async function list(userId?: string, projectId?: string): Promise<BucketView[]> {
  const userBuckets = userId ? listUserBuckets(userId) : null;
  const out = await getS3Client().send(new ListBucketsCommand({}));
  let userFiltered = userBuckets
    ? (out.Buckets || []).filter((b) => userBuckets.includes(b.Name!))
    : (out.Buckets || []);
  if (projectId) {
    userFiltered = userFiltered.filter((b) => getBucketProjectId(b.Name!) === projectId);
  }
  return Promise.all(
    userFiltered.map(async (b) => {
      try {
        const { size, objectCount } = await bucketStats(b.Name!);
        return {
          name: b.Name,
          creationDate: b.CreationDate,
          size,
          objectCount,
          protected: isBucketProtected(b.Name!),
          projectId: getBucketProjectId(b.Name!),
        };
      } catch {
        return {
          name: b.Name,
          creationDate: b.CreationDate,
          size: 0,
          objectCount: 0,
          protected: isBucketProtected(b.Name!),
          projectId: getBucketProjectId(b.Name!),
        };
      }
    }),
  );
}

export function get(name: string): BucketView {
  return { name, protected: isBucketProtected(name), creationDate: undefined, size: 0, objectCount: 0, projectId: getBucketProjectId(name) };
}

export async function create(userId: string | undefined, name: string, protect?: boolean, projectId?: string): Promise<{ name: string; protected: boolean }> {
  if (!name.trim()) throw new HttpError(400, 'A bucket name is required.');
  await getS3Client().send(new CreateBucketCommand({ Bucket: name }));
  const p = !!protect;
  if (userId) setBucketOwner(name, userId, p, projectId || null);
  return { name, protected: p };
}

export async function remove(name: string, userId?: string): Promise<void> {
  if (userId) {
    const owner = getBucketOwner(name);
    if (owner && owner !== userId) throw new HttpError(403, 'Bucket does not belong to your account.');
  }
  if (isBucketProtected(name)) {
    throw new HttpError(403, 'This bucket is protected — unprotect it before deleting.');
  }
  try {
    await getS3Client().send(new DeleteBucketCommand({ Bucket: name }));
  } catch (err: any) {
    const code = err?.Code || err?.name;
    if (code === 'BucketNotEmpty') throw new HttpError(409, 'Bucket is not empty — delete its objects first.');
    throw err;
  }
}

export function setProtected(name: string, protect: boolean, projectId?: string | null): void {
  setBucketProtected(name, protect);
  if (projectId !== undefined) {
    setBucketOwner(name, '', protect, projectId);
  }
}

export async function listObjects(name: string, prefix?: string): Promise<ObjectList> {
  const pfx = typeof prefix === 'string' ? prefix : '';
  const out = await getS3Client().send(
    new ListObjectsV2Command({ Bucket: name, Prefix: pfx, Delimiter: '/' }),
  );
  return {
    prefixes: (out.CommonPrefixes || []).map((p) => p.Prefix).filter(Boolean) as Array<string | undefined>,
    objects: (out.Contents || [])
      .filter((o) => o.Key !== pfx)
      .map((o) => ({
        key: o.Key,
        size: o.Size ?? 0,
        lastModified: o.LastModified,
      })),
  };
}

export async function getObject(name: string, key: string): Promise<{ body: NodeJS.ReadableStream; contentType: string; contentLength?: number }> {
  const out = await getS3Client().send(new GetObjectCommand({ Bucket: name, Key: key }));
  return {
    body: out.Body as NodeJS.ReadableStream,
    contentType: out.ContentType || 'application/octet-stream',
    contentLength: out.ContentLength ?? undefined,
  };
}

export async function putObject(name: string, key: string, body: Buffer, contentType?: string): Promise<void> {
  if (!key) throw new HttpError(400, 'An object key is required.');
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: name,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    }),
  );
}

export async function deleteObject(name: string, key: string): Promise<void> {
  if (isBucketProtected(name)) {
    throw new HttpError(403, 'This bucket is protected — unprotect it before deleting objects.');
  }
  await getS3Client().send(new DeleteObjectCommand({ Bucket: name, Key: key }));
}

export async function replaceInObject(name: string, key: string, search: string, replace: string): Promise<ReplaceResult> {
  if (!key) throw new HttpError(400, 'An object key is required.');
  if (!search) throw new HttpError(400, 'search string is required.');

  const out = await getS3Client().send(new GetObjectCommand({ Bucket: name, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of out.Body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const current = Buffer.concat(chunks).toString('utf8');
  const replaced = current.split(search).join(replace);
  if (replaced === current) {
    throw new HttpError(404, 'Search string not found in object.');
  }
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: name,
      Key: key,
      Body: replaced,
      ContentType: out.ContentType || 'application/octet-stream',
    }),
  );
  return { replacements: current.split(search).length - 1, content: replaced };
}

export async function writeObjects(name: string, objects: WriteObjectInput[]): Promise<{ ok: true; objectsWritten: number }> {
  if (!Array.isArray(objects) || objects.length === 0) {
    throw new HttpError(400, 'objects must be a non-empty array of { key, content, contentType? }.');
  }
  await Promise.all(
    objects.map((obj) =>
      getS3Client().send(
        new PutObjectCommand({
          Bucket: name,
          Key: obj.key,
          Body: obj.content,
          ContentType: obj.contentType || 'text/plain',
        }),
      ),
    ),
  );
  return { ok: true, objectsWritten: objects.length };
}
