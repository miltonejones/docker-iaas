import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { docker, isSelfContainerized, remoteDockerHost } from './docker.js';
import { getS3Client } from './minio.js';
import { getRoutesByName, getFunction, getFunctionEnv, type RouteRow } from './db.js';
import { runLambda, entryPathOf, fullFileSet } from './routes/lambda.js';

declare global {
  namespace Express {
    interface Request {
      gwRoute?: RouteRow;
    }
  }
}

// Mounted at /gw, before the app-wide express.json() — container targets need
// to stream the raw request body through untouched.
export const gatewayProxyRouter = Router();

// A real sub-router (not a plain path-matched middleware) so Express strips
// the /:routeName prefix from req.path/req.url for everything inside it.
const dispatch = Router({ mergeParams: true });
gatewayProxyRouter.use('/:routeName', dispatch);

dispatch.use((req: Request, res: Response, next: NextFunction) => {
  const routes = getRoutesByName(req.params.routeName);
  if (routes.length === 0) {
    res.status(404).json({ error: `No gateway route named "${req.params.routeName}".` });
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
    res.status(404).json({
      error: `No route matches ${reqMethod} ${req.path} under "${req.params.routeName}".`,
    });
    return;
  }

  req.gwRoute = best;
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
    if (!res.headersSent) res.status(502).json({ error: (err as Error).message });
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

  res.status(404).json({ error: `Object "${key}" not found in bucket "${route.target_id}".` });
}

async function handleContainer(route: RouteRow, req: Request, res: Response): Promise<void> {
  const info = await docker.getContainer(route.target_id).inspect();
  if (!info.State?.Running) {
    res.status(502).json({ error: 'Target container is not running.' });
    return;
  }

  const port = route.target_port;
  let target: string;
  if (isSelfContainerized()) {
    target = `http://${(info.Name || '').replace(/^\//, '')}:${port}`;
  } else {
    const binding = info.NetworkSettings?.Ports?.[`${port}/tcp`]?.[0];
    if (!binding?.HostPort) {
      res.status(502).json({
        error: `Container port ${port} is not published to the host — required to reach it from this process.`,
      });
      return;
    }
    target = `http://${remoteDockerHost() ?? '127.0.0.1'}:${binding.HostPort}`;
  }

  const proxy = createProxyMiddleware({ target, changeOrigin: true });
  proxy(req, res, (err?: unknown) => {
    if (err && !res.headersSent) res.status(502).json({ error: String(err) });
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
    res.status(404).json({ error: 'Target function no longer exists.' });
    return;
  }

  const bodyBuf = req.body as Buffer | undefined;
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
    res.status(502).json({ error: result.stderr || `Function exited with code ${result.exitCode}`, stdout: result.stdout });
    return;
  }

  let proxyResponse: ProxyResponse;
  try {
    proxyResponse = JSON.parse(result.stdout.trim());
  } catch {
    res.status(502).json({
      error: 'Malformed Lambda proxy response: function did not print valid JSON to stdout.',
      stdout: result.stdout,
    });
    return;
  }
  if (typeof proxyResponse.statusCode !== 'number') {
    res.status(502).json({
      error: 'Malformed Lambda proxy response: missing numeric "statusCode".',
      stdout: result.stdout,
    });
    return;
  }

  if (proxyResponse.headers) {
    for (const [k, v] of Object.entries(proxyResponse.headers)) res.set(k, v);
  }
  const body = proxyResponse.body ?? '';
  res.status(proxyResponse.statusCode).send(proxyResponse.isBase64Encoded ? Buffer.from(body, 'base64') : body);
}
