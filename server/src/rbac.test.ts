// Must set before dynamic imports — auth.ts fails fast without it.
process.env.JWT_SECRET = 'dockyard-test-secret';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type express from 'express';
import http from 'node:http';

function jsonRequest(
  app: express.Express,
  method: string,
  path: string,
  headers?: Record<string, string>,
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
          ...(headers || {}),
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

describe('requireRole middleware', () => {
  let jwt: typeof import('jsonwebtoken').default;
  let expressModule: typeof express;
  let requireAuth: typeof import('./auth.js').requireAuth;
  let requireRole: typeof import('./auth.js').requireRole;
  let initDb: typeof import('./db.js').initDb;
  let createUser: typeof import('./db.js').createUser;
  let setUserRole: typeof import('./db.js').setUserRole;
  let countUsersByRole: typeof import('./db.js').countUsersByRole;

  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;
  let oldToken: string;
  let app: express.Express;

  before(async () => {
    jwt = (await import('jsonwebtoken')).default;
    expressModule = (await import('express')).default;
    const auth = await import('./auth.js');
    requireAuth = auth.requireAuth;
    requireRole = auth.requireRole;
    const db = await import('./db.js');
    initDb = db.initDb;
    createUser = db.createUser;
    setUserRole = db.setUserRole;
    countUsersByRole = db.countUsersByRole;

    initDb(':memory:');
    const admin = createUser('admin@test.com', 'hash');
    const operator = createUser('operator@test.com', 'hash');
    const viewer = createUser('viewer@test.com', 'hash');

    setUserRole(operator.id, 'operator');
    setUserRole(viewer.id, 'viewer');

    const secret = process.env.JWT_SECRET!;
    adminToken = jwt.sign({ userId: admin.id, email: admin.email, role: 'admin' }, secret, { expiresIn: '1h' });
    operatorToken = jwt.sign({ userId: operator.id, email: operator.email, role: 'operator' }, secret, { expiresIn: '1h' });
    viewerToken = jwt.sign({ userId: viewer.id, email: viewer.email, role: 'viewer' }, secret, { expiresIn: '1h' });
    oldToken = jwt.sign({ userId: admin.id, email: admin.email }, secret, { expiresIn: '1h' });
    app = createApp();
  });

  function createApp() {
    const app = expressModule();
    app.use(expressModule.json());

    app.get('/api/test/public', requireAuth, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    app.post('/api/test/write', requireAuth, requireRole('operator'), (_req: any, res: any) => {
      res.json({ ok: true });
    });

    app.delete('/api/test/admin', requireAuth, requireRole('admin'), (_req: any, res: any) => {
      res.json({ ok: true });
    });

    return app;
  }


  it('admin is implicitly allowed everywhere', async () => {
    let res = await jsonRequest(app, 'GET', '/api/test/public', { Authorization: `Bearer ${adminToken}` });
    assert.equal(res.status, 200);
    res = await jsonRequest(app, 'POST', '/api/test/write', { Authorization: `Bearer ${adminToken}` });
    assert.equal(res.status, 200);
    res = await jsonRequest(app, 'DELETE', '/api/test/admin', { Authorization: `Bearer ${adminToken}` });
    assert.equal(res.status, 200);
  });

  it('operator can access operator+ routes but not admin', async () => {
    const res1 = await jsonRequest(app, 'POST', '/api/test/write', { Authorization: `Bearer ${operatorToken}` });
    assert.equal(res1.status, 200);
    const res2 = await jsonRequest(app, 'DELETE', '/api/test/admin', { Authorization: `Bearer ${operatorToken}` });
    assert.equal(res2.status, 403);
    assert.ok((res2.data as any).error?.includes('Requires role'));
  });

  it('viewer can only access GET routes', async () => {
    let res = await jsonRequest(app, 'GET', '/api/test/public', { Authorization: `Bearer ${viewerToken}` });
    assert.equal(res.status, 200);
    res = await jsonRequest(app, 'POST', '/api/test/write', { Authorization: `Bearer ${viewerToken}` });
    assert.equal(res.status, 403);
  });

  it('returns 500 when requireRole is mounted without requireAuth', async () => {
    const app2 = expressModule();
    app2.get('/test', requireRole('admin'), (_req: any, res: any) => res.json({ ok: true }));
    const res = await jsonRequest(app2, 'GET', '/test');
    assert.equal(res.status, 500);
  });

  it('old JWT without role claim still works (backwards compat)', async () => {
    const res = await jsonRequest(app, 'DELETE', '/api/test/admin', { Authorization: `Bearer ${oldToken}` });
    assert.equal(res.status, 200, 'Old role-less token should work when DB user is admin');
  });
});

describe('last-admin guard', () => {
  let initDb: typeof import('./db.js').initDb;
  let createUser: typeof import('./db.js').createUser;
  let setUserRole: typeof import('./db.js').setUserRole;
  let countUsersByRole: typeof import('./db.js').countUsersByRole;

  before(async () => {
    const db = await import('./db.js');
    initDb = db.initDb;
    createUser = db.createUser;
    setUserRole = db.setUserRole;
    countUsersByRole = db.countUsersByRole;
  });

  it('last remaining admin cannot be demoted', () => {
    initDb(':memory:');
    const admin = createUser('admin2@test.com', 'hash');
    createUser('viewer2@test.com', 'hash');

    assert.equal(countUsersByRole('admin'), 1, 'Should be exactly 1 admin');

    const ok = setUserRole(admin.id, 'viewer');
    assert.ok(ok, 'DB-level role change should succeed');
    assert.equal(countUsersByRole('admin'), 0);
  });
});
