// Must set before dynamic imports — auth.ts fails fast without it.
process.env.JWT_SECRET = 'dockyard-test-secret';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type express from 'express';

function jsonRequest(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const opts: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: addr.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
        },
      };

      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk; });
        res.on('end', () => {
          server.close();
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: data || null });
          }
        });
      });
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

describe('gateway audit logging', () => {
  let initDb: typeof import('./db.js').initDb;
  let createRoute: typeof import('./db/gateway.js').createRoute;
  let listAuditLogs: typeof import('./db/audit.js').listAuditLogs;
  let gatewayRouter: import('./routes/gateway.js').gatewayRouter;
  let expressModule: typeof express;

  before(async () => {
    expressModule = (await import('express')).default;
    const db = await import('./db.js');
    initDb = db.initDb;
    const gwDb = await import('./db/gateway.js');
    createRoute = gwDb.createRoute;
    listAuditLogs = (await import('./db/audit.js')).listAuditLogs;
    const gw = await import('./routes/gateway.js');
    gatewayRouter = gw.gatewayRouter;
    initDb(':memory:');
  });

  it('route create emits audit event', async () => {
    const app = expressModule();
    app.use(expressModule.json());
    app.use('/api/gateway', gatewayRouter);

    const res = await jsonRequest(app, 'POST', '/api/gateway', {
      name: 'testroute',
      targetType: 'container',
      targetId: 'abc123',
      targetPort: 3000,
    });

    assert.equal(res.status, 201);

    const rows = listAuditLogs();
    const matching = rows.filter((r) => r.action === 'gateway.route.create');
    assert.equal(matching.length, 1);
    assert.equal(matching[0].resource_type, 'route');
    assert.equal(matching[0].detail, 'testroute');
  });

  it('route delete emits audit event', async () => {
    const route = createRoute(
      `rt-deletetest`,
      'deleteme',
      'container',
      'abc123',
      3000,
      'GET',
      '/test',
      null,
      null,
    );

    const app = expressModule();
    app.use(expressModule.json());
    app.use('/api/gateway', gatewayRouter);

    const res = await jsonRequest(app, 'DELETE', `/api/gateway/${route.id}`);

    assert.equal(res.status, 200);

    const rows = listAuditLogs();
    const matching = rows.filter((r) => r.action === 'gateway.route.delete');
    assert.equal(matching.length, 1);
    assert.equal(matching[0].resource_type, 'route');
    assert.equal(matching[0].resource_id, route.id);
  });
});
