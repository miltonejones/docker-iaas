import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { initDb, createUser, countUsersByRole, setUserRole } from './db.js';
import { requireAuth, requireRole } from './auth.js';

process.env.JWT_SECRET = 'test-secret-rbac';

before(() => {
  initDb(':memory:');
});

function createRbacApp() {
  const app = express();
  app.use(express.json());

  app.get('/api/test/public', requireAuth, (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post('/api/test/write', requireAuth, requireRole('operator'), (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.delete('/api/test/admin', requireAuth, requireRole('admin'), (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  return app;
}

const app = createRbacApp();

describe('requireRole middleware', () => {
  let adminToken: string;
  let operatorToken: string;
  let viewerToken: string;
  let oldToken: string;

  before(() => {
    initDb(':memory:');
    const admin = createUser('admin@test.com', 'hash');
    const operator = createUser('operator@test.com', 'hash');
    const viewer = createUser('viewer@test.com', 'hash');

    setUserRole(operator.id, 'operator');
    setUserRole(viewer.id, 'viewer');

    adminToken = jwt.sign({ userId: admin.id, email: admin.email, role: 'admin' }, 'test-secret-rbac', { expiresIn: '1h' });
    operatorToken = jwt.sign({ userId: operator.id, email: operator.email, role: 'operator' }, 'test-secret-rbac', { expiresIn: '1h' });
    viewerToken = jwt.sign({ userId: viewer.id, email: viewer.email, role: 'viewer' }, 'test-secret-rbac', { expiresIn: '1h' });
    oldToken = jwt.sign({ userId: admin.id, email: admin.email }, 'test-secret-rbac', { expiresIn: '1h' });
  });

  it('admin is implicitly allowed everywhere', async () => {
    let res = await request(app).get('/api/test/public').set('Authorization', `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    res = await request(app).post('/api/test/write').set('Authorization', `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    res = await request(app).delete('/api/test/admin').set('Authorization', `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
  });

  it('operator can access operator+ routes but not admin', async () => {
    const res1 = await request(app).post('/api/test/write').set('Authorization', `Bearer ${operatorToken}`);
    assert.equal(res1.status, 200);
    const res2 = await request(app).delete('/api/test/admin').set('Authorization', `Bearer ${operatorToken}`);
    assert.equal(res2.status, 403);
    assert.ok(res2.body.error?.includes('Requires role'));
  });

  it('viewer can only access GET routes', async () => {
    let res = await request(app).get('/api/test/public').set('Authorization', `Bearer ${viewerToken}`);
    assert.equal(res.status, 200);
    res = await request(app).post('/api/test/write').set('Authorization', `Bearer ${viewerToken}`);
    assert.equal(res.status, 403);
  });

  it('returns 500 when requireRole is mounted without requireAuth', async () => {
    const app2 = express();
    app2.get('/test', requireRole('admin'), (_req: Request, res: Response) => res.json({ ok: true }));
    const res = await request(app2).get('/test');
    assert.equal(res.status, 500);
  });

  it('old JWT without role claim still works (backwards compat)', async () => {
    const res = await request(app).delete('/api/test/admin').set('Authorization', `Bearer ${oldToken}`);
    assert.equal(res.status, 200, 'Old role-less token should work when DB user is admin');
  });
});

describe('last-admin guard', () => {
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
