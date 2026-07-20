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
import { authRouter } from './routes/auth.js';
import { requireAuth } from './auth.js';
import { gatewayProxyRouter } from './gatewayProxy.js';
import { initDb } from './db.js';
import { connectToRelay } from './relay.js';
import { ensureMinio } from './minio.js';

// Initialize the SQLite database.
initDb();

// Parse --connect <url> from command-line args.
const connectArg = process.argv.find((a) => a.startsWith('--connect='));
const relayUrl = process.env.RELAY_URL || (connectArg ? connectArg.split('=')[1] : '');

const app = express();
app.use(cors());

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
app.use('/api/auth', authRouter);

// Serve the built frontend in production (web/dist), if present.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.use((_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

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
  if (relayUrl) {
    connectToRelay(relayUrl);
  }
});
