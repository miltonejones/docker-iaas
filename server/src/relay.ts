import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';
import { getUsageSnapshot } from './usage.js';

const POLL_MS = Number(process.env.USAGE_POLL_MS || 5000);
const LOCAL_PORT = Number(process.env.PORT || 4300);

/**
 * Connect to a Dockyard relay and proxy incoming API calls to the local
 * Express server. Pushes usage data upstream on an interval.
 */
export function connectToRelay(relayUrl: string): void {
  let ws: WebSocket | null = null;
  let usageTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let backoff = 1000;

  function connect() {
    if (ws) {
      ws.removeAllListeners();
      ws.close();
    }

    console.log(`[relay] Connecting to ${relayUrl}…`);
    ws = new WebSocket(relayUrl);

    ws.on('open', () => {
      console.log('[relay] Connected.');
      backoff = 1000;

      // Start pushing usage data.
      if (usageTimer) clearInterval(usageTimer);
      usageTimer = setInterval(pushUsage, POLL_MS);
      pushUsage(); // immediate first push
    });

    ws.on('message', async (raw) => {
      let msg: { type: string; id?: string; method?: string; path?: string; body?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type !== 'call' || !msg.id) return;

      // Proxy the call to the local Express server.
      try {
        const result = await proxyLocal(msg.method || 'GET', msg.path || '/', msg.body);
        ws?.send(
          JSON.stringify({
            type: 'response',
            id: msg.id,
            status: result.status,
            body: result.body,
          }),
        );
      } catch (err) {
        ws?.send(
          JSON.stringify({
            type: 'response',
            id: msg.id,
            status: 502,
            body: { error: (err as Error).message },
          }),
        );
      }
    });

    ws.on('close', () => {
      console.log('[relay] Disconnected. Reconnecting…');
      if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.error(`[relay] Error: ${err.message}`);
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      backoff = Math.min(backoff * 2, 30_000);
      connect();
    }, backoff);
  }

  async function pushUsage() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const snapshot = await getUsageSnapshot();
      ws.send(JSON.stringify({ type: 'usage', data: snapshot }));
    } catch {
      /* ignore */
    }
  }

  /** Proxy an HTTP call to the local Express server. */
  function proxyLocal(
    method: string,
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: LOCAL_PORT,
          method,
          path,
          headers: bodyStr
            ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bodyStr)) }
            : {},
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => {
            let parsed: unknown = data;
            try {
              parsed = JSON.parse(data);
            } catch {
              /* keep as string */
            }
            resolve({ status: res.statusCode || 200, body: parsed });
          });
        },
      );
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  connect();
}
