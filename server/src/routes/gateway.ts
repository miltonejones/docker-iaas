import { Router, type Request, type Response } from 'express';
import { getAuthUser, requireRole } from '../auth.js';
import { HttpError } from '../services/HttpError.js';
import * as gatewayService from '../services/gateway.js';
import { assertNotProtected, checkProtectedWarning } from '../services/projects.js';

// Re-export constants for backward compat.
export { NAME_RE, TARGET_TYPES, VALID_METHODS } from '../services/gateway.js';

export const gatewayRouter = Router();

function sendError(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unknown error.' });
}

// ── Route CRUD ────────────────────────────────────────────────

gatewayRouter.get('/', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : undefined;
    res.json(gatewayService.list(userId, projectId));
  } catch (err) {
    sendError(res, err);
  }
});

gatewayRouter.post('/', requireRole('operator'), (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.status(201).json(gatewayService.createRoute(userId, req.body));
  } catch (err) {
    sendError(res, err);
  }
});

gatewayRouter.put('/:id', requireRole('operator'), (req: Request, res: Response) => {
  try {
    if (req.body?.targetPort != null) {
      assertNotProtected('routes', req.params.id, req.authUser?.role);
    }
    const warning = req.body?.targetPort != null ? checkProtectedWarning('routes', req.params.id) : null;
    const userId = getAuthUser(req)?.userId;
    res.json({ ...gatewayService.updateRoute(req.params.id, userId, req.body), ...(warning ? { warning } : {}) });
  } catch (err) {
    sendError(res, err);
  }
});

gatewayRouter.delete('/:id', requireRole('operator'), (req: Request, res: Response) => {
  try {
    assertNotProtected('routes', req.params.id, req.authUser?.role);
    const warning = checkProtectedWarning('routes', req.params.id);
    const userId = getAuthUser(req)?.userId;
    gatewayService.deleteGatewayRoute(req.params.id, userId);
    res.json({ ok: true, ...(warning ? { warning } : {}) });
  } catch (err) {
    sendError(res, err);
  }
});

// ── Traffic ───────────────────────────────────────────────────

gatewayRouter.get('/traffic/summary', (req: Request, res: Response) => {
  try {
    res.json(gatewayService.trafficSummary({
      windowHours: req.query.windowHours,
      gatewayName: req.query.gatewayName,
      routeId: req.query.routeId,
      targetType: req.query.targetType,
    }));
  } catch (err) {
    sendError(res, err);
  }
});

gatewayRouter.get('/traffic/requests', (req: Request, res: Response) => {
  try {
    res.json(gatewayService.trafficRequests({
      windowHours: req.query.windowHours,
      limit: req.query.limit,
      gatewayName: req.query.gatewayName,
      routeId: req.query.routeId,
      targetType: req.query.targetType,
      method: req.query.method,
      statusCode: req.query.statusCode,
      errorClassification: req.query.errorClassification,
    }));
  } catch (err) {
    sendError(res, err);
  }
});

gatewayRouter.get('/traffic/timeseries', (req: Request, res: Response) => {
  try {
    res.json(gatewayService.trafficTimeseries(req.query.windowHours));
  } catch (err) {
    sendError(res, err);
  }
});

// ── Preview (Playwright screenshot) — stays in route ──────────

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PREVIEW_DIR = path.resolve(process.env.PREVIEW_DIR || 'data/previews');
fs.mkdirSync(PREVIEW_DIR, { recursive: true });

interface PreviewEntry { body: Buffer; contentType: string; at: number }
const previewCache = new Map<string, PreviewEntry>();
const PREVIEW_TTL_MS = 30_000;

let browserPromise: ReturnType<typeof import('playwright').chromium.launch> | null = null;
let previewLock: Promise<void> = Promise.resolve();

function getBrowser() {
  if (!browserPromise) {
    browserPromise = import('playwright').then(({ chromium }) =>
      chromium.launch({ headless: true }),
    );
  }
  return browserPromise;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- TODO(gap-00)
function routeHash(name: string): string {
  const routes = gatewayService.list();
  return crypto.createHash('sha1').update(JSON.stringify(routes)).digest('hex').slice(0, 12);
}

function diskPath(name: string, width: number, height: number, hash: string): string {
  return path.join(PREVIEW_DIR, `${name}_${width}x${height}_${hash}.png`);
}

function readDisk(name: string, width: number, height: number): Buffer | null {
  const hash = routeHash(name);
  const file = diskPath(name, width, height, hash);
  try { return fs.readFileSync(file); }
  catch { return null; }
}

function writeDisk(name: string, width: number, height: number, body: Buffer): string {
  const hash = routeHash(name);
  const prefix = `${name}_`;
  try {
    for (const f of fs.readdirSync(PREVIEW_DIR)) {
      if (f.startsWith(prefix) && !f.includes(`_${hash}.`)) {
        fs.unlinkSync(path.join(PREVIEW_DIR, f));
      }
    }
  } catch { /* best-effort cleanup */ }
  const file = diskPath(name, width, height, hash);
  fs.writeFileSync(file, body);
  return file;
}

gatewayRouter.get('/preview/:name', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!name || !gatewayService.NAME_RE.test(name)) {
    res.status(400).json({ error: 'Invalid route name.' });
    return;
  }

  const width = Math.min(1920, Math.max(320, Number(req.query.width) || 1280));
  const height = Math.min(2160, Math.max(240, Number(req.query.height) || 720));
  const cacheKey = `${name}-${width}-${height}`;

  const cached = previewCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PREVIEW_TTL_MS) {
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=60');
    res.send(cached.body);
    return;
  }

  const diskBody = readDisk(name, width, height);
  if (diskBody) {
    previewCache.set(cacheKey, { body: diskBody, contentType: 'image/png', at: Date.now() });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=60');
    res.send(diskBody);
    return;
  }

  previewLock = previewLock.then(async () => {
    try {
      const browser = await getBrowser();
      const page = await browser.newPage({ viewport: { width, height } });

      const port = process.env.PORT || 4300;
      const url = `http://127.0.0.1:${port}/gw/${encodeURIComponent(name)}/`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15_000 });

      const body = await page.screenshot({ type: 'png', fullPage: false });
      await page.close();

      for (const [k, v] of previewCache) {
        if (Date.now() - v.at > PREVIEW_TTL_MS) previewCache.delete(k);
      }
      previewCache.set(cacheKey, { body, contentType: 'image/png', at: Date.now() });
      writeDisk(name, width, height, body);

      if (!res.headersSent) {
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=60');
        res.send(body);
      }
    } catch (err) {
      if (!res.headersSent) {
        const msg = (err as Error).message;
        if (msg.includes('Timeout') || msg.includes('timeout')) {
          res.status(504).json({ error: 'Preview timed out — the target may be slow or unreachable.' });
        } else {
          res.status(500).json({ error: msg });
        }
      }
    }
  });
});

// ── Domain management ─────────────────────────────────────────

gatewayRouter.patch('/:id/domain', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    const { domain } = req.body as { domain?: string | null };
    res.json(gatewayService.setDomain(req.params.id, userId, domain ?? null));
  } catch (err) {
    sendError(res, err);
  }
});

gatewayRouter.get('/:id/domain/preflight', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(await gatewayService.domainPreflight(req.params.id, userId));
  } catch (err) {
    sendError(res, err);
  }
});

gatewayRouter.post('/:id/domain/enable', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(await gatewayService.enableDomain(req.params.id, userId));
  } catch (err) {
    sendError(res, err);
  }
});

gatewayRouter.get('/:id/domain/status', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(gatewayService.checkDomainStatus(req.params.id, userId));
  } catch (err) {
    sendError(res, err);
  }
});

gatewayRouter.delete('/:id/domain', async (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    await gatewayService.removeDomain(req.params.id, userId);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ── DNS ───────────────────────────────────────────────────────

gatewayRouter.get('/dns/zones', async (_req: Request, res: Response) => {
  try {
    res.json(await gatewayService.listDnsZones());
  } catch (err) {
    sendError(res, err);
  }
});

gatewayRouter.get('/dns/zones/:zoneId/records', async (req: Request, res: Response) => {
  try {
    const name = typeof req.query.name === 'string' && req.query.name ? req.query.name : undefined;
    res.json(await gatewayService.listDnsRecords(req.params.zoneId, name));
  } catch (err) {
    sendError(res, err);
  }
});

gatewayRouter.post('/dns/zones/:zoneId/records', async (req: Request, res: Response) => {
  try {
    const { name } = req.body as { name?: string };
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    res.json(await gatewayService.createDnsRecord(req.params.zoneId, name));
  } catch (err) {
    sendError(res, err);
  }
});

gatewayRouter.delete('/dns/zones/:zoneId/records/:name', async (req: Request, res: Response) => {
  try {
    await gatewayService.deleteDnsRecord(req.params.zoneId, req.params.name);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});
