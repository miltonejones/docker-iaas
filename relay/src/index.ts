import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import express, { type Response } from 'express';
import cors from 'cors';

const PORT = Number(process.env.PORT || 4400);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface PendingRequest {
  res: Response;
  timeout: NodeJS.Timeout;
}

const nodes = new Map<string, WebSocket>();       // nodeId → socket
const pending = new Map<string, PendingRequest>(); // requestId → HTTP response
const sseClients = new Set<Response>();             // active SSE connections
let nodeCounter = 0;

// ---------------------------------------------------------------------------
// Express (HTTP API)
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

// Relay status — tells the web app whether a node is connected.
app.get('/api/system/ping', (_req, res) => {
  const connected = nodes.size > 0;
  res.json({
    ok: connected,
    relay: true,
    nodes: nodes.size,
    version: 'dockyard-relay',
  });
});

// SSE usage stream — fed by node usage pushes.
app.get('/api/system/usage/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Catch-all API proxy — forward to connected node.
app.all('/api/*', (req, res) => {
  const node = firstNode();
  if (!node) {
    res.status(503).json({ error: 'No Dockyard instance connected.' });
    return;
  }

  const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const timeout = setTimeout(() => {
    pending.delete(id);
    if (!res.headersSent) {
      res.status(504).json({ error: 'Request timed out waiting for node.' });
    }
  }, 30_000);

  pending.set(id, { res, timeout });

  // Read body if present.
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    const msg: Record<string, unknown> = {
      type: 'call',
      id,
      method: req.method,
      path: req.originalUrl,
    };
    if (body) {
      try {
        msg.body = JSON.parse(body);
      } catch {
        msg.body = body;
      }
    }
    node.send(JSON.stringify(msg));
  });
});

// Serve static frontend if built.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const nodeId = `node-${++nodeCounter}`;
  nodes.set(nodeId, ws);
  console.log(`Node connected: ${nodeId} (${nodes.size} total)`);

  ws.on('message', (raw) => {
    let msg: { type: string; id?: string; status?: number; body?: unknown; data?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'response': {
        const req = pending.get(msg.id || '');
        if (!req) return;
        clearTimeout(req.timeout);
        pending.delete(msg.id || '');
        const { res } = req;
        if (res.headersSent) return;
        res.status(msg.status || 200).json(msg.body);
        break;
      }
      case 'usage': {
        const frame = `data: ${JSON.stringify(msg.data)}\n\n`;
        for (const client of sseClients) {
          client.write(frame);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    nodes.delete(nodeId);
    console.log(`Node disconnected: ${nodeId} (${nodes.size} total)`);
    // Fail any pending requests from this node.
    for (const [id, req] of pending) {
      clearTimeout(req.timeout);
      if (!req.res.headersSent) {
        req.res.status(502).json({ error: 'Node disconnected.' });
      }
      pending.delete(id);
    }
  });

  ws.on('error', () => {
    nodes.delete(nodeId);
  });
});

function firstNode(): WebSocket | undefined {
  for (const [, ws] of nodes) {
    if (ws.readyState === WebSocket.OPEN) return ws;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`\n  Dockyard relay listening on http://0.0.0.0:${PORT}`);
  console.log(`  WebSocket upgrade on same port.`);
  console.log('');
});
