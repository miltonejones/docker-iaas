import { Router, type Request, type Response } from 'express';
import express from 'express';
import { getAuthUser } from '../auth.js';
import { HttpError } from '../services/HttpError.js';
import * as bucketService from '../services/buckets.js';

export const bucketsRouter = Router();

function sendError(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 502;
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unknown error.' });
}

bucketsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(await bucketService.list(userId));
  } catch (err) {
    sendError(res, err);
  }
});

bucketsRouter.get('/:name', (req: Request, res: Response) => {
  res.json(bucketService.get(req.params.name));
});

bucketsRouter.post('/:name/protected', express.json(), (req: Request, res: Response) => {
  const protect = !!req.body?.protected;
  const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : undefined;
  const userId = getAuthUser(req)?.userId;
  bucketService.setProtected(req.params.name, protect, projectId, userId);
  res.json({ name: req.params.name, protected: protect });
});

bucketsRouter.post('/', express.json(), async (req: Request, res: Response) => {
  const name = (req.body?.name || '').trim();
  const userId = getAuthUser(req)?.userId;
  const protect = !!req.body?.protected;
  const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : undefined;
  try {
    const result = await bucketService.create(userId, name, protect, projectId);
    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

bucketsRouter.delete('/:name', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    await bucketService.remove(req.params.name, userId);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

bucketsRouter.get('/:name/objects', async (req: Request, res: Response) => {
  const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
  try {
    res.json(await bucketService.listObjects(req.params.name, prefix));
  } catch (err) {
    sendError(res, err);
  }
});

// Raw-body upload — Express middleware handles body parsing.
bucketsRouter.put(
  '/:name/objects/:key(.*)',
  express.raw({ type: '*/*', limit: '200mb' }),
  async (req: Request, res: Response) => {
    const key = req.params.key;
    try {
      await bucketService.putObject(
        req.params.name,
        key,
        req.body as Buffer,
        req.get('content-type') || 'application/octet-stream',
      );
      res.status(201).json({ key });
    } catch (err) {
      sendError(res, err);
    }
  },
);

// Streaming GET — pipe response directly.
bucketsRouter.get('/:name/objects/:key(.*)', async (req: Request, res: Response) => {
  const key = req.params.key;
  try {
    const out = await bucketService.getObject(req.params.name, key);
    res.set('Content-Type', out.contentType);
    if (out.contentLength != null) res.set('Content-Length', String(out.contentLength));
    res.set('Content-Disposition', `attachment; filename="${key.split('/').pop()}"`);
    out.body.pipe(res);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

bucketsRouter.delete('/:name/objects/:key(.*)', async (req: Request, res: Response) => {
  const key = req.params.key;
  try {
    await bucketService.deleteObject(req.params.name, key);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

bucketsRouter.post('/:name/objects/replace', express.json(), async (req: Request, res: Response) => {
  const key = String(req.body?.key ?? '').trim();
  const search = String(req.body?.search ?? '');
  const replace = String(req.body?.replace ?? '');
  try {
    const result = await bucketService.replaceInObject(req.params.name, key, search, replace);
    res.json({ key, replaced: true, occurrences: result.replacements });
  } catch (err) {
    sendError(res, err);
  }
});

bucketsRouter.post('/:name/objects/bulk', express.json(), async (req: Request, res: Response) => {
  const objects = req.body?.objects;
  try {
    res.json(await bucketService.writeObjects(req.params.name, objects));
  } catch (err) {
    sendError(res, err);
  }
});
