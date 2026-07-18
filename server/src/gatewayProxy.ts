import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { docker, isSelfContainerized, remoteDockerHost } from './docker.js';
import { getS3Client } from './minio.js';
import {
  getRoutesByName,
  getFunction,
  getFunctionEnv,
  recordGatewayTrafficEvent,
  type RouteRow,
} from './db.js';
import { runLambda, entryPathOf, fullFileSet } from './routes/lambda.js';

declare global {
  namespace Express {
    interface Request {
      gwRoute?: RouteRow;
      gwTelemetry?: GatewayTelemetryState;
    }
  }
}

interface GatewayTelemetryState {
  gatewayName: string;
  routeId: string | null;
  targetType: string | null;
  requestBytes: number;
  errorClassification: string | null;
}

// Mounted at /gw, before the app-wide express.json() — container targets need
// to stream the raw request body through untouched.
export const gatewayProxyRouter = Router();

// A real sub-router (not a plain path-matched middleware) so Express strips
// the /:routeName prefix from req.path/req.url for everything inside it.
const dispatch = Router({ mergeParams: true });
gatewayProxyRouter.use('/:routeName', dispatch);

function parseContentLength(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function chunkByteLength(chunk: unknown, encoding?: BufferEncoding): number {
  if (chunk == null) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, encoding);
  return Buffer.byteLength(String(chunk));
}

function setGatewayResolution(req: Request, route: RouteRow | null): void {
  if (!req.gwTelemetry) return;
  req.gwTelemetry.routeId = route?.id || null;
  req.gwTelemetry.targetType = route?.target_type || null;
}

function setGatewayError(req: Request, classification: string): void {
  if (!req.gwTelemetry) return;
  req.gwTelemetry.errorClassification = classification;
}

function updateGatewayRequestBytes(req: Request, bytes: number): void {
  if (!req.gwTelemetry) return;
  req.gwTelemetry.requestBytes = Math.max(req.gwTelemetry.requestBytes, Math.round(bytes));
}

function finalizeGatewayErrorClassification(
  classification: string | null,
  statusCode: number,
  finished: boolean,
): string | null {
  if (!finished) return 'client_aborted';
  if (classification) return classification;
  if (statusCode >= 500) return 'upstream_server_error';
  if (statusCode >= 400) return 'upstream_client_error';
  return null;
}

function sendGatewayJsonError(
  req: Request,
  res: Response,
  statusCode: number,
  classification: string,
  error: string,
  extra: Record<string, unknown> = {},
): void {
  setGatewayError(req, classification);
  res.status(statusCode).json({ error, ...extra });
}

dispatch.use((req: Request, res: Response, next: NextFunction) => {
  const startedAt = process.hrtime.bigint();
  req.gwTelemetry = {
    gatewayName: req.params.routeName,
    routeId: null,
    targetType: null,
    requestBytes: parseContentLength(req.headers['content-length']),
    errorClassification: null,
  };

  let responseBytes = 0;
  let recorded = false;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = ((chunk: unknown, encoding?: BufferEncoding, cb?: ((error?: Error | null) => void)) => {
    responseBytes += chunkByteLength(chunk, encoding);
    return originalWrite(chunk as never, encoding as never, cb as never);
  }) as Response['write'];
  res.end = ((chunk?: unknown, encoding?: BufferEncoding, cb?: (() => void)) => {
    responseBytes += chunkByteLength(chunk, encoding);
    return originalEnd(chunk as never, encoding as never, cb as never);
  }) as Response['end'];

  const record = (finished: boolean) => {
    if (recorded) return;
    recorded = true;

    try {
      recordGatewayTrafficEvent({
        gatewayName: req.gwTelemetry?.gatewayName || req.params.routeName,
        routeId: req.gwTelemetry?.routeId || null,
        targetType: req.gwTelemetry?.targetType || null,
        method: req.method.toUpperCase(),
        path: req.path || '/',
        statusCode: finished ? res.statusCode : 499,
        durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
        requestBytes: req.gwTelemetry?.requestBytes || 0,
        responseBytes,
        errorClassification: finalizeGatewayErrorClassification(
          req.gwTelemetry?.errorClassification || null,
          finished ? res.statusCode : 499,
          finished,
        ),
      });
    } catch (err) {
      console.error('Failed to record gateway telemetry:', err);
    }
  };

  res.on('finish', () => record(true));
  res.on('close', () => {
    if (!res.writableFinished) record(false);
  });

  next();
});

dispatch.use((req: Request, res: Response, next: NextFunction) => {
  const routes = getRoutesByName(req.params.routeName);
  if (routes.length === 0) {
    sendGatewayJsonError(
      req,
      res,
      404,
      'route_not_found',
      `No gateway route named "${req.params.routeName}".`,
    );
    return;
  }

  // Pick the most specific matching route.
  // Priority: method+path > path-only > method-only > catch-all (neither).
  const reqMethod = req.method.toUpperCase();
  const reqPath = req.path;

  let best: RouteRow | undefined;
  let bestScore = -1;

  for (const r of routes) {
    const methodMatch = !r.method || r.method.toUpperCase() === reqMethod;
    const pathMatch = !r.path_pattern || reqPath === r.path_pattern;
    if (!methodMatch || !pathMatch) continue;

    // Score: 3 = both match, 2 = path only, 1 = method only, 0 = catch-all.
    const score = (r.method ? 1 : 0) + (r.path_pattern ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }

  if (!best) {
    sendGatewayJsonError(
      req,
      res,
      404,
      'route_unmatched',
      `No route matches ${reqMethod} ${req.path} under "${req.params.routeName}".`,
    );
    return;
  }

  req.gwRoute = best;
  setGatewayResolution(req, best);
  next();
});

// Only the lambda target needs the body as structured data; container
// proxying streams the raw body through, and bucket targets are read-only.
dispatch.use((req: Request, res: Response, next: NextFunction) => {
  if (req.gwRoute?.target_type === 'lambda') {
    express.raw({ type: '*/*', limit: '5mb' })(req, res, next);
    return;
  }
  next();
});

dispatch.use(async (req: Request, res: Response) => {
  const route = req.gwRoute!;
  try {
    if (route.target_type === 'bucket') await handleBucket(route, req, res);
    else if (route.target_type === 'container') await handleContainer(route, req, res);
    else await handleLambda(route, req, res);
  } catch (err) {
    if (!res.headersSent) {
      sendGatewayJsonError(req, res, 502, 'gateway_internal_error', (err as Error).message);
    }
  }
});

async function fetchBucketObject(bucket: string, key: string) {
  return getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
}

async function handleBucket(route: RouteRow, req: Request, res: Response): Promise<void> {
  let key = req.path.replace(/^\//, '');
  if (key === '' || key.endsWith('/')) key += 'index.html';

  try {
    const out = await fetchBucketObject(route.target_id, key);
    res.set('Content-Type', out.ContentType || 'application/octet-stream');
    if (out.ContentLength != null) res.set('Content-Length', String(out.ContentLength));
    (out.Body as NodeJS.ReadableStream).pipe(res);
    return;
  } catch {
    /* fall through to SPA fallback below */
  }

  // SPA fallback: a path with no file extension (e.g. a client-side router
  // path like /list/1) that doesn't exist as an object gets index.html
  // instead, mirroring how S3 website hosting / CloudFront serve SPAs.
  const looksLikeFile = /\.[a-zA-Z0-9]+$/.test(key);
  if (!looksLikeFile && key !== 'index.html') {
    try {
      const out = await fetchBucketObject(route.target_id, 'index.html');
      res.set('Content-Type', out.ContentType || 'text/html');
      if (out.ContentLength != null) res.set('Content-Length', String(out.ContentLength));
      (out.Body as NodeJS.ReadableStream).pipe(res);
      return;
    } catch {
      /* no index.html either — fall through to 404 */
    }
  }

  sendGatewayJsonError(
    req,
    res,
    404,
    'bucket_object_not_found',
    `Object "${key}" not found in bucket "${route.target_id}".`,
  );
}

async function handleContainer(route: RouteRow, req: Request, res: Response): Promise<void> {
  let info;
  try {
    info = await docker.getContainer(route.target_id).inspect();
  } catch {
    sendGatewayJsonError(req, res, 502, 'container_lookup_failed', 'Target container is not available.');
    return;
  }
  if (!info.State?.Running) {
    sendGatewayJsonError(req, res, 502, 'container_not_running', 'Target container is not running.');
    return;
  }

  const port = route.target_port;
  let target: string;
  if (isSelfContainerized()) {
    target = `http://${(info.Name || '').replace(/^\//, '')}:${port}`;
  } else {
    const binding = info.NetworkSettings?.Ports?.[`${port}/tcp`]?.[0];
    if (!binding?.HostPort) {
      sendGatewayJsonError(
        req,
        res,
        502,
        'container_port_unpublished',
        `Container port ${port} is not published to the host — required to reach it from this process.`,
      );
      return;
    }
    target = `http://${remoteDockerHost() ?? '127.0.0.1'}:${binding.HostPort}`;
  }

  const proxy = createProxyMiddleware({ target, changeOrigin: true });
  proxy(req, res, (err?: unknown) => {
    if (err && !res.headersSent) {
      sendGatewayJsonError(req, res, 502, 'container_proxy_error', String(err));
    }
  });
}

/** AWS API Gateway REST API "Lambda proxy integration" event shape. */
interface ProxyEvent {
  httpMethod: string;
  path: string;
  headers: Record<string, string | undefined>;
  queryStringParameters: Record<string, string> | null;
  pathParameters: Record<string, string> | null;
  body: string | null;
  isBase64Encoded: boolean;
}

/** The shape a handler must print to stdout — mirrors what a real Lambda
 *  proxy integration expects back, so API Gateway's actual "malformed
 *  response" failure mode is reproduced locally instead of papered over. */
interface ProxyResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

async function handleLambda(route: RouteRow, req: Request, res: Response): Promise<void> {
  const fn = getFunction(route.target_id);
  if (!fn) {
    sendGatewayJsonError(req, res, 404, 'lambda_target_missing', 'Target function no longer exists.');
    return;
  }

  const bodyBuf = req.body as Buffer | undefined;
  if (bodyBuf) updateGatewayRequestBytes(req, bodyBuf.length);
  const event: ProxyEvent = {
    httpMethod: req.method,
    path: req.path,
    headers: req.headers as Record<string, string | undefined>,
    queryStringParameters: Object.keys(req.query).length > 0 ? (req.query as Record<string, string>) : null,
    pathParameters: null,
    body: bodyBuf && bodyBuf.length > 0 ? bodyBuf.toString('utf8') : null,
    isBase64Encoded: false,
  };

  const packages = (fn.packages || '').trim().split(/\s+/).filter(Boolean);
  const envVars = Object.entries(getFunctionEnv(fn.id)).map(([k, v]) => `${k}=${v}`);
  const result = await runLambda(
    fn.runtime,
    fullFileSet(fn),
    entryPathOf(fn),
    packages,
    [...envVars, `DOCKYARD_REQUEST=${JSON.stringify(event)}`],
  );

  if (result.exitCode !== 0) {
    sendGatewayJsonError(
      req,
      res,
      502,
      'lambda_execution_failed',
      result.stderr || `Function exited with code ${result.exitCode}`,
      { stdout: result.stdout },
    );
    return;
  }

  let proxyResponse: ProxyResponse;
  try {
    proxyResponse = JSON.parse(result.stdout.trim());
  } catch {
    sendGatewayJsonError(
      req,
      res,
      502,
      'lambda_malformed_response',
      'Malformed Lambda proxy response: function did not print valid JSON to stdout.',
      { stdout: result.stdout },
    );
    return;
  }
  if (typeof proxyResponse.statusCode !== 'number') {
    sendGatewayJsonError(
      req,
      res,
      502,
      'lambda_malformed_response',
      'Malformed Lambda proxy response: missing numeric "statusCode".',
      { stdout: result.stdout },
    );
    return;
  }

  if (proxyResponse.headers) {
    for (const [k, v] of Object.entries(proxyResponse.headers)) res.set(k, v);
  }
  const body = proxyResponse.body ?? '';
  res.status(proxyResponse.statusCode).send(proxyResponse.isBase64Encoded ? Buffer.from(body, 'base64') : body);
}
