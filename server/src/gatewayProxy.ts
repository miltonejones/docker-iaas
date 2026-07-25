import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import { getRoutesByName, recordGatewayTrafficEvent, type RouteRow } from './db.js';
import {
  handleBucket,
  handleContainer,
  handleLambda,
  type GatewayTelemetryState,
  parseContentLength,
  chunkByteLength,
  setGatewayResolution,
  setGatewayError,
  finalizeGatewayErrorClassification,
} from './gatewayHandlers.js';

declare global {
  namespace Express {
    interface Request {
      gwRoute?: RouteRow;
      gwTelemetry?: GatewayTelemetryState;
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
  const startedAt = process.hrtime.bigint();
  req.gwTelemetry = {
    gatewayName: req.params.routeName,
    routeId: null,
    targetType: null,
    requestBytes: parseContentLength(req.headers['content-length']),
    errorClassification: null,
    entryPoint: 'gw_prefix',
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
  const telem = req.gwTelemetry!;

  if (routes.length === 0) {
    setGatewayError(telem, 'route_not_found');
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
    setGatewayError(telem, 'route_unmatched');
    res.status(404).json({ error: `No route matches ${reqMethod} ${req.path} under "${req.params.routeName}".` });
    return;
  }

  req.gwRoute = best;
  setGatewayResolution(telem, best);
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
  const telem = req.gwTelemetry!;
  try {
    if (route.target_type === 'bucket') await handleBucket(route, req, res, telem);
    else if (route.target_type === 'container') await handleContainer(route, req, res, telem);
    else await handleLambda(route, req, res, telem);
  } catch (err) {
    if (!res.headersSent) {
      setGatewayError(telem, 'gateway_internal_error');
      res.status(502).json({ error: (err as Error).message });
    }
  }
});
