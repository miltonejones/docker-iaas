import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { requireAuth, optionalAuth, webhookAuth } from '../auth.js';

// ---------------------------------------------------------------------------
// Dummy routers — return 200 so we can verify auth middleware blocks them
// ---------------------------------------------------------------------------

function dummy(name: string): express.Router {
  const r = express.Router();
  r.all('*', (_req, res) => res.json({ ok: true, route: name }));
  return r;
}

// ---------------------------------------------------------------------------
// Test app — mirrors the middleware layout of `createApp()` in index.ts.
// If you add a new router mount in index.ts, you MUST update this test.
// ---------------------------------------------------------------------------

function createTestApp() {
  const app = express();

  // Gateway data plane — intentionally unauthenticated.
  app.use('/gw', dummy('gateway'));

  // Protected API routes (mounted before body parser, same as prod).
  app.use('/api/buckets', requireAuth, dummy('buckets'));

  app.use(express.json({ limit: '2mb' }));

  app.use('/api/containers', requireAuth, dummy('containers'));
  app.use('/api/images', requireAuth, dummy('images'));
  app.use('/api/system', dummy('system')); // per-route requireAuth inside router
  app.use('/api/lambda', requireAuth, dummy('lambda'));
  app.use('/api/gateway', requireAuth, dummy('gateway'));
  app.use('/api/volumes', requireAuth, dummy('volumes'));
  app.use('/api/host-files', requireAuth, dummy('host-files'));
  app.use('/api/host-builds', requireAuth, dummy('host-builds'));
  app.use('/api/databases', requireAuth, dummy('databases'));
  app.use('/api/github', webhookAuth, dummy('github'));
  app.use('/api/assistant', requireAuth, dummy('assistant'));
  app.use('/api/notifications', optionalAuth, dummy('notifications'));
  app.use('/api/auth', dummy('auth'));

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const app = createTestApp();

interface RouteCase {
  method: 'get' | 'post';
  path: string;
  /** Expected status without a token. 401 for protected, not-401 for public. */
  expectUnauthenticated: number;
}

const routes: RouteCase[] = [
  // ── Public (no auth required) ──────────────────────────────────────────
  { method: 'get',  path: '/gw/anything',               expectUnauthenticated: 200 },
  { method: 'post', path: '/api/auth/login',            expectUnauthenticated: 200 },
  { method: 'post', path: '/api/auth/register',         expectUnauthenticated: 200 },
  { method: 'post', path: '/api/auth/consumer',         expectUnauthenticated: 200 },
  // notifications uses optionalAuth — succeeds without token
  { method: 'get',  path: '/api/notifications/stream',  expectUnauthenticated: 200 },
  // system router has per-route requireAuth (not mount-level) — test app uses
  // a dummy that returns 200 for everything.  Actual auth on system routes is
  // verified by the real systemRouter's internal requireAuth calls.
  { method: 'get',  path: '/api/system/usage/stream',   expectUnauthenticated: 200 }, // intentionally public (SSE)
  { method: 'get',  path: '/api/system/ping',            expectUnauthenticated: 200 }, // dummy; real router has requireAuth
  { method: 'get',  path: '/api/system/usage',           expectUnauthenticated: 200 }, // dummy; real router has requireAuth
  { method: 'get',  path: '/api/system/audit',           expectUnauthenticated: 200 }, // dummy; real router has requireAuth
  { method: 'get',  path: '/api/system/presets',         expectUnauthenticated: 200 }, // dummy; real router has requireAuth

  // ── Protected (requireAuth at mount level) — MUST return 401 without token ─
  { method: 'get',  path: '/api/buckets',               expectUnauthenticated: 401 },
  { method: 'get',  path: '/api/containers',             expectUnauthenticated: 401 },
  { method: 'get',  path: '/api/images',                 expectUnauthenticated: 401 },
  { method: 'get',  path: '/api/lambda/functions',       expectUnauthenticated: 401 },
  { method: 'get',  path: '/api/gateway',                expectUnauthenticated: 401 },
  { method: 'get',  path: '/api/volumes',                expectUnauthenticated: 401 },
  { method: 'get',  path: '/api/host-files',             expectUnauthenticated: 401 },
  { method: 'get',  path: '/api/host-builds',            expectUnauthenticated: 401 },
  { method: 'get',  path: '/api/databases/overview',     expectUnauthenticated: 401 },
  // ── Protected (webhookAuth) — MUST return 401 without token or secret ─
  { method: 'get',  path: '/api/github/pull-to-bucket',  expectUnauthenticated: 401 },
  { method: 'post', path: '/api/github/commit-and-push', expectUnauthenticated: 401 },
  { method: 'get',  path: '/api/assistant/sessions',     expectUnauthenticated: 401 },
];

describe('auth coverage', () => {
  for (const { method, path, expectUnauthenticated } of routes) {
    it(`${method.toUpperCase()} ${path} → ${expectUnauthenticated} (unauthenticated)`, async () => {
      const req = (request(app) as any)[method](path);
      const res = await req;
      assert.equal(res.status, expectUnauthenticated,
        `Expected ${expectUnauthenticated} for unauthenticated ${method.toUpperCase()} ${path}, got ${res.status}`);
    });
  }
});

// ---------------------------------------------------------------------------
// webhookAuth-specific tests
// ---------------------------------------------------------------------------

describe('webhookAuth', () => {
  it('rejects requests with no auth (no JWT, no webhook secret)', async () => {
    const res = await request(app).get('/api/github/pull-to-bucket');
    assert.equal(res.status, 401);
  });

  it('rejects requests with an invalid webhook secret', async () => {
    const res = await request(app)
      .get('/api/github/pull-to-bucket')
      .set('x-webhook-secret', 'wrong-secret');
    assert.equal(res.status, 401);
  });

  it('accepts requests with a valid webhook secret', async () => {
    // GITHUB_WEBHOOK_SECRET is set via env in the test environment
    // or via Docker secret; we test with whatever is configured.
    // This test only passes if GITHUB_WEBHOOK_SECRET is set.
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      // Skip if no webhook secret is configured (e.g., CI without Docker secrets)
      return;
    }
    const res = await request(app)
      .get('/api/github/pull-to-bucket')
      .set('x-webhook-secret', secret);
    assert.equal(res.status, 200);
  });

  it('rejects an invalid JWT even when webhook secret is wrong', async () => {
    const res = await request(app)
      .get('/api/github/pull-to-bucket')
      .set('Authorization', 'Bearer invalid-token')
      .set('x-webhook-secret', 'wrong-secret');
    assert.equal(res.status, 401);
  });
});