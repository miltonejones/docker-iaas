import { Router, type Request, type Response } from 'express';
import { getAuthUser } from '../auth.js';
import {
  listRoutes,
  getRoutesByName,
  createRoute,
  deleteRoute,
  updateRoute,
  listGatewayTrafficEvents,
  summarizeGatewayTraffic,
  summarizeGatewayTrafficByHour,
} from '../db.js';

export const gatewayRouter = Router();

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const TARGET_TYPES = new Set(['bucket', 'container', 'lambda']);
const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 30;
const DEFAULT_REQUEST_LIMIT = 100;
const MAX_REQUEST_LIMIT = 200;

class GatewayApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendError(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

function stringQuery(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function integerQuery(
  value: unknown,
  fallback: number,
  label: string,
  min: number,
  max: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new GatewayApiError(400, `${label} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function toJson(r: import('../db.js').RouteRow) {
  return {
    id: r.id,
    name: r.name,
    displayName: r.display_name || null,
    targetType: r.target_type,
    targetId: r.target_id,
    targetPort: r.target_port,
    method: r.method || null,
    pathPattern: r.path_pattern || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function trafficEventJson(r: import('../db.js').GatewayTrafficEventRow) {
  return {
    id: r.id,
    occurredAt: r.occurred_at,
    gatewayName: r.gateway_name,
    routeId: r.route_id,
    targetType: r.target_type,
    method: r.method,
    path: r.path,
    statusCode: r.status_code,
    durationMs: r.duration_ms,
    requestBytes: r.request_bytes,
    responseBytes: r.response_bytes,
    errorClassification: r.error_classification,
  };
}

function trafficSummaryJson(r: import('../db.js').GatewayTrafficSummaryRow) {
  return {
    gatewayName: r.gateway_name,
    routeId: r.route_id,
    targetType: r.target_type,
    routeMethod: r.route_method,
    routePathPattern: r.route_path_pattern,
    requestCount: r.request_count,
    successfulRequests: r.success_count,
    clientErrorRequests: r.client_error_count,
    serverErrorRequests: r.server_error_count,
    avgDurationMs: r.avg_duration_ms,
    maxDurationMs: r.max_duration_ms,
    totalRequestBytes: r.total_request_bytes,
    totalResponseBytes: r.total_response_bytes,
    lastSeenAt: r.last_seen_at,
    errorCounts: r.error_counts,
  };
}

gatewayRouter.get('/', (req: Request, res: Response) => {
  try {
    const userId = getAuthUser(req)?.userId;
    res.json(listRoutes(userId).map(toJson));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

gatewayRouter.get('/traffic/summary', (req: Request, res: Response) => {
  try {
    const windowHours = integerQuery(
      req.query.windowHours,
      DEFAULT_WINDOW_HOURS,
      'windowHours',
      1,
      MAX_WINDOW_HOURS,
    );
    const until = new Date();
    const since = new Date(until.getTime() - windowHours * 60 * 60 * 1000);
    const gatewayName = stringQuery(req.query.gatewayName);
    const routeId = stringQuery(req.query.routeId);
    const targetType = stringQuery(req.query.targetType);
    if (targetType && !TARGET_TYPES.has(targetType)) {
      throw new GatewayApiError(400, `targetType must be one of: ${Array.from(TARGET_TYPES).join(', ')}.`);
    }

    const rows = summarizeGatewayTraffic({
      since: since.toISOString(),
      until: until.toISOString(),
      gatewayName,
      routeId,
      targetType,
    });

    res.json({
      windowHours,
      since: since.toISOString(),
      until: until.toISOString(),
      filters: {
        gatewayName,
        routeId,
        targetType,
      },
      totalRequests: rows.reduce((sum, row) => sum + row.request_count, 0),
      routes: rows.map(trafficSummaryJson),
    });
  } catch (err) {
    const status = err instanceof GatewayApiError ? err.status : 500;
    sendError(res, status, (err as Error).message);
  }
});

gatewayRouter.get('/traffic/requests', (req: Request, res: Response) => {
  try {
    const windowHours = integerQuery(
      req.query.windowHours,
      DEFAULT_WINDOW_HOURS,
      'windowHours',
      1,
      MAX_WINDOW_HOURS,
    );
    const limit = integerQuery(req.query.limit, DEFAULT_REQUEST_LIMIT, 'limit', 1, MAX_REQUEST_LIMIT);
    const until = new Date();
    const since = new Date(until.getTime() - windowHours * 60 * 60 * 1000);

    const gatewayName = stringQuery(req.query.gatewayName);
    const routeId = stringQuery(req.query.routeId);
    const targetType = stringQuery(req.query.targetType);
    const method = stringQuery(req.query.method)?.toUpperCase() || null;
    const errorClassification = stringQuery(req.query.errorClassification);
    const statusCode = req.query.statusCode == null ? null : integerQuery(req.query.statusCode, 0, 'statusCode', 100, 599);

    if (targetType && !TARGET_TYPES.has(targetType)) {
      throw new GatewayApiError(400, `targetType must be one of: ${Array.from(TARGET_TYPES).join(', ')}.`);
    }
    if (method && !VALID_METHODS.has(method)) {
      throw new GatewayApiError(400, `method must be one of: ${Array.from(VALID_METHODS).join(', ')}.`);
    }

    const result = listGatewayTrafficEvents(
      {
        since: since.toISOString(),
        until: until.toISOString(),
        gatewayName,
        routeId,
        targetType,
        method,
        statusCode,
        errorClassification,
      },
      limit,
    );

    res.json({
      windowHours,
      since: since.toISOString(),
      until: until.toISOString(),
      limit,
      filters: {
        gatewayName,
        routeId,
        targetType,
        method,
        statusCode,
        errorClassification,
      },
      totalMatched: result.totalMatched,
      requests: result.events.map(trafficEventJson),
    });

    gatewayRouter.get('/traffic/timeseries', (req: Request, res: Response) => {
      try {
        const windowHours = integerQuery(
          req.query.windowHours,
          DEFAULT_WINDOW_HOURS,
          'windowHours',
          1,
          MAX_WINDOW_HOURS,
        );
        const until = new Date();
        const since = new Date(until.getTime() - windowHours * 60 * 60 * 1000);
        const rows = summarizeGatewayTrafficByHour({
          since: since.toISOString(),
          until: until.toISOString(),
        });
        res.json({
          windowHours,
          since: since.toISOString(),
          until: until.toISOString(),
          buckets: rows.map((row) => ({
            start: row.bucket_start,
            requestCount: row.request_count,
            successfulRequests: row.success_count,
            clientErrorRequests: row.client_error_count,
            serverErrorRequests: row.server_error_count,
          })),
        });
      } catch (err) {
        const status = err instanceof GatewayApiError ? err.status : 500;
        sendError(res, status, (err as Error).message);
      }
    });
  } catch (err) {
    const status = err instanceof GatewayApiError ? err.status : 500;
    sendError(res, status, (err as Error).message);
  }
});

gatewayRouter.post('/', (req: Request, res: Response) => {
  try {
    const { name, displayName, targetType, targetId, targetPort, method, pathPattern } = req.body as {
      name?: string;
      displayName?: string;
      targetType?: string;
      targetId?: string;
      targetPort?: number;
      method?: string;
      pathPattern?: string;
    };

    if (!name || !NAME_RE.test(name)) {
      res.status(400).json({ error: 'Name must be lowercase letters, digits, and hyphens, starting with a letter or digit.' });
      return;
    }
    if (!targetType || !TARGET_TYPES.has(targetType)) {
      res.status(400).json({ error: `targetType must be one of: ${Array.from(TARGET_TYPES).join(', ')}.` });
      return;
    }
    if (!targetId?.trim()) {
      res.status(400).json({ error: 'A targetId is required.' });
      return;
    }
    if (targetType === 'container' && !targetPort) {
      res.status(400).json({ error: 'A targetPort is required for container routes.' });
      return;
    }

    const methodNorm = method?.trim().toUpperCase() || null;
    if (methodNorm && !VALID_METHODS.has(methodNorm)) {
      res.status(400).json({ error: `Invalid method. Must be one of: ${Array.from(VALID_METHODS).join(', ')}.` });
      return;
    }

    const pathNorm = pathPattern?.trim() || null;
    if (pathNorm && !pathNorm.startsWith('/')) {
      res.status(400).json({ error: 'pathPattern must start with "/".' });
      return;
    }

    // Check for duplicate: same name + same method + same path.
    const existing = getRoutesByName(name);
    const dup = existing.find(
      (r) => (r.method || null) === methodNorm && (r.path_pattern || null) === pathNorm,
    );
    if (dup) {
      const desc = [name, methodNorm, pathNorm].filter(Boolean).join(' ');
      res.status(409).json({ error: `A route matching "${desc}" already exists.` });
      return;
    }

    const userId = getAuthUser(req)?.userId;
    const id = `rt-${Math.random().toString(36).slice(2, 8)}`;
    const row = createRoute(
      id,
      name,
      targetType,
      targetId.trim(),
      targetType === 'container' ? Number(targetPort) : null,
      methodNorm,
      pathNorm,
      userId,
      displayName?.trim() || null,
    );
    res.status(201).json(toJson(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

gatewayRouter.put('/:id', (req: Request, res: Response) => {
  try {
    const { displayName } = req.body as { displayName?: string | null };
    const row = updateRoute(req.params.id, { displayName });
    if (!row) { res.status(404).json({ error: 'Route not found.' }); return; }
    res.json(toJson(row));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

gatewayRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    const deleted = deleteRoute(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Route not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Preview (Playwright screenshot) ────────────────────────────────────

interface PreviewEntry { body: Buffer; contentType: string; at: number }
const previewCache = new Map<string, PreviewEntry>();
const PREVIEW_TTL_MS = 30_000; // cache screenshots for 30 seconds

// Singleton browser + concurrency guard — launching multiple Chromium
// instances simultaneously can OOM small instances.
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

gatewayRouter.get('/preview/:name', async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!name || !NAME_RE.test(name)) {
    res.status(400).json({ error: 'Invalid route name.' });
    return;
  }

  const width = Math.min(1920, Math.max(320, Number(req.query.width) || 1280));
  const height = Math.min(2160, Math.max(240, Number(req.query.height) || 720));
  const cacheKey = `${name}-${width}-${height}`;

  const cached = previewCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PREVIEW_TTL_MS) {
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=30');
    res.send(cached.body);
    return;
  }

  // Serialise all screenshot work through a single lock so only one
  // page is open at a time.  Concurrent requests either hit the cache
  // above or queue behind each other.
  previewLock = previewLock.then(async () => {
    try {
      const browser = await getBrowser();
      const page = await browser.newPage({ viewport: { width, height } });

      const port = process.env.PORT || 4300;
      const url = `http://127.0.0.1:${port}/gw/${encodeURIComponent(name)}/`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15_000 });

      const body = await page.screenshot({ type: 'png', fullPage: false });
      await page.close();

      // Evict stale entries.
      for (const [k, v] of previewCache) {
        if (Date.now() - v.at > PREVIEW_TTL_MS) previewCache.delete(k);
      }
      previewCache.set(cacheKey, { body, contentType: 'image/png', at: Date.now() });

      // Only the first waiter actually sends the response; all others
      // will pick it up from the cache on the next event-loop tick.
      if (!res.headersSent) {
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=30');
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
