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
import { initDb } from './db.js';
import { connectToRelay } from './relay.js';

// Initialize the SQLite database.
initDb();

// Parse --connect <url> from command-line args.
const connectArg = process.argv.find((a) => a.startsWith('--connect='));
const relayUrl = process.env.RELAY_URL || (connectArg ? connectArg.split('=')[1] : '');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/containers', containersRouter);
app.use('/api/images', imagesRouter);
app.use('/api/system', systemRouter);
app.use('/api/lambda', lambdaRouter);

// Serve the built frontend in production (web/dist), if present.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

const port = Number(process.env.PORT || 4300);
app.listen(port, '0.0.0.0', async () => {
  await ensureNetwork();
  const ping = await pingDocker();
  console.log(`\n  Dockyard server listening on http://0.0.0.0:${port}`);
  console.log(
    ping.ok
      ? `  Docker daemon reachable (Engine v${ping.version}).`
      : `  ⚠ Docker daemon NOT reachable: ${ping.error}\n    Set DOCKER_HOST / DOCKER_SOCKET as needed.`,
  );
  console.log('');

  // Connect to relay if configured.
  if (relayUrl) {
    connectToRelay(relayUrl);
  }
});
