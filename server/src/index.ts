import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import { ensureNetwork, pingDocker } from './docker.js';
import { containersRouter } from './routes/containers.js';
import { imagesRouter } from './routes/images.js';
import { systemRouter } from './routes/system.js';
import { lambdaRouter } from './routes/lambda.js';
import { bucketsRouter } from './routes/buckets.js';
import { gatewayRouter } from './routes/gateway.js';
import { volumesRouter } from './routes/volumes.js';
import { assistantRouter } from './routes/assistant.js';
import { hostFilesRouter } from './routes/hostFiles.js';
import { hostBuildsRouter } from './routes/hostBuilds.js';
import { databasesRouter } from './routes/databases.js';
import { githubRouter } from './routes/github.js';
import { notificationsRouter } from './routes/notifications.js';
import { authRouter } from './routes/auth.js';
import { requireAuth, optionalAuth } from './auth.js';
import { gatewayProxyRouter } from './gatewayProxy.js';
import {
  handleBucket,
  handleContainer,
  handleLambda,
  parseContentLength,
  setGatewayError,
  chunkByteLength,
  finalizeGatewayErrorClassification,
  type GatewayTelemetryState,
} from './gatewayHandlers.js';
import { reloadCaddy } from './caddy.js';
import { getRouteByDomain, recordGatewayTrafficEvent } from './db.js';
import { initDb } from './db.js';
import { connectToRelay } from './relay.js';
import { ensureMinio } from './minio.js';

/** Build the Express application (without starting the listener).  Tests can
 *  call this directly to mount the app in supertest without binding a port. */
export function createApp(): express.Express {
  // Initialize the SQLite database.
  initDb();

  const app = express();
  app.use(cors());

  // ── Custom-domain routing (before /gw so Host-header matches win) ─────
  app.use(async (req, res, next) => {
    const hostname = req.hostname || req.headers.host?.split(':')[0] || '';
    const route = getRouteByDomain(hostname);
    if (!route) return next();

    const startedAt = process.hrtime.bigint();
    const telem: GatewayTelemetryState = {
      gatewayName: route.name,
      routeId: route.id,
      targetType: route.target_type,
      requestBytes: parseContentLength(req.headers['content-length']),
      errorClassification: null,
      entryPoint: 'custom_domain',
    };

    // Byte counting for telemetry (same pattern as /gw dispatcher).
    let responseBytes = 0;
    let recorded = false;
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    res.write = ((chunk: unknown, encoding?: BufferEncoding, cb?: (error?: Error | null) => void) => {
      responseBytes += chunkByteLength(chunk, encoding);
      return originalWrite(chunk as never, encoding as never, cb as never);
    }) as typeof res.write;
    res.end = ((chunk?: unknown, encoding?: BufferEncoding, cb?: () => void) => {
      responseBytes += chunkByteLength(chunk, encoding);
      return originalEnd(chunk as never, encoding as never, cb as never);
    }) as typeof res.end;

    const record = (finished: boolean) => {
      if (recorded) return;
      recorded = true;
      try {
        recordGatewayTrafficEvent({
          gatewayName: telem.gatewayName,
          routeId: telem.routeId,
          targetType: telem.targetType,
          method: req.method.toUpperCase(),
          path: req.path || '/',
          statusCode: finished ? res.statusCode : 499,
          durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
          requestBytes: telem.requestBytes,
          responseBytes,
          errorClassification: finalizeGatewayErrorClassification(
            telem.errorClassification, finished ? res.statusCode : 499, finished,
          ),
          entryPoint: telem.entryPoint,
        });
      } catch { /* best-effort */ }
    };
    res.on('finish', () => record(true));
    res.on('close', () => { if (!res.writableFinished) record(false); });

    // Lambda targets need the body as structured data.
    if (route.target_type === 'lambda') {
      express.raw({ type: '*/*', limit: '5mb' })(req, res, async () => {
        try { await handleLambda(route, req, res, telem);
        } catch (err) { if (!res.headersSent) { setGatewayError(telem, 'gateway_internal_error'); res.status(502).json({ error: (err as Error).message }); } }
      });
      return;
    }

    try {
      if (route.target_type === 'bucket') await handleBucket(route, req, res, telem);
      else if (route.target_type === 'container') await handleContainer(route, req, res, telem);
    } catch (err) {
      if (!res.headersSent) {
        setGatewayError(telem, 'gateway_internal_error');
        res.status(502).json({ error: (err as Error).message });
      }
    }
  });

  // Gateway data-plane routes and bucket object uploads/downloads are mounted
  // before the JSON body parser — otherwise a request with
  // Content-Type: application/json (e.g. uploading a manifest.json) would get
  // its body consumed by express.json() before the raw-body route handler
  // ever sees it.
  app.use('/gw', gatewayProxyRouter);
  app.use('/api/buckets', requireAuth, bucketsRouter);

  app.use(express.json({ limit: '2mb' }));

  app.use('/api/containers', requireAuth, containersRouter);
  app.use('/api/images', requireAuth, imagesRouter);
  app.use('/api/system', systemRouter);
  app.use('/api/lambda', requireAuth, lambdaRouter);
  app.use('/api/gateway', requireAuth, gatewayRouter);
  app.use('/api/volumes', requireAuth, volumesRouter);
  app.use('/api/host-files', requireAuth, hostFilesRouter);
  app.use('/api/host-builds', requireAuth, hostBuildsRouter);
  app.use('/api/databases', requireAuth, databasesRouter);
  app.use('/api/github', githubRouter);
  app.use('/api/assistant', requireAuth, assistantRouter);
  app.use('/api/notifications', optionalAuth, notificationsRouter);
  app.use('/api/auth', authRouter);

  // Serve the built frontend in production (web/dist), if present.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.use((_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  return app;
}

// Parse --connect <url> from command-line args.
const connectArg = process.argv.find((a) => a.startsWith('--connect='));
const relayUrl = process.env.RELAY_URL || (connectArg ? connectArg.split('=')[1] : '');

// Only start the listener when this file is the direct entrypoint — importing
// it (e.g. from a test) must not bind a port or print startup banners.
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const app = createApp();
  const port = Number(process.env.PORT || 4300);
  app.listen(port, '0.0.0.0', async () => {
    await ensureNetwork();
    const ping = await pingDocker();
    console.log(`\n  Dockyard.ai server listening on http://0.0.0.0:${port}`);
    console.log(
      ping.ok
        ? `  Docker daemon reachable (Engine v${ping.version}).`
        : `  ⚠ Docker daemon NOT reachable: ${ping.error}\n    Set DOCKER_HOST / DOCKER_SOCKET as needed.`,
    );
    console.log('');

    if (ping.ok) {
      try {
        await ensureMinio();
        console.log('  MinIO (buckets) ready.\n');
      } catch (err) {
        console.log(`  ⚠ MinIO provisioning failed: ${(err as Error).message}\n`);
      }
    }

    // Connect to relay if configured.
    // Re-apply persisted custom-domain blocks into Caddy.
    try { await reloadCaddy(); } catch { /* best-effort: Caddy may be unavailable */ }

    // Connect to relay if configured.
    if (relayUrl) {
      connectToRelay(relayUrl);
    }
  });
}
