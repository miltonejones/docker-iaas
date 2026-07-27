// Must set before the dynamic import of auth.ts, which does process.exit(1)
// if no secret is available.
process.env.JWT_SECRET = 'dockyard-webhook-test-secret';
// Provide a known webhook secret for testing.
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

let webhookAuth: typeof import('./auth.js').webhookAuth;
let signToken: typeof import('./auth.js').signToken;
let loadWebhookSecret: typeof import('./auth.js').loadWebhookSecret;
let initDb: typeof import('./db.js').initDb;
let createUser: typeof import('./db.js').createUser;

// Will be set in before() hook after creating the DB user.
let testUserId: string;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/github', webhookAuth, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('webhookAuth middleware', () => {
  let app: express.Express;

  before(async () => {
    const authMod = await import('./auth.js');
    webhookAuth = authMod.webhookAuth;
    signToken = authMod.signToken;
    loadWebhookSecret = authMod.loadWebhookSecret;

    const dbMod = await import('./db.js');
    initDb = dbMod.initDb;
    createUser = dbMod.createUser;

    // Initialise in-memory DB and create the user that signToken will reference.
    initDb(':memory:');
    const user = createUser('webhook-test@dockyard.test', 'hash_unused');
    testUserId = user.id;

    app = createApp();
  });

  // ── JWT path ──────────────────────────────────────────────────────────────

  it('accepts a valid JWT and sets req.authUser', async () => {
    const token = signToken({ id: testUserId, email: 'webhook-test@dockyard.test' });
    const res = await request(app)
      .get('/api/github/test')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('rejects an invalid JWT (falls through to webhook check)', async () => {
    const res = await request(app)
      .get('/api/github/test')
      .set('Authorization', 'Bearer invalid-token');
    // Falls through to webhook secret check, which also fails → 401
    assert.equal(res.status, 401);
  });

  // ── Webhook secret path ────────────────────────────────────────────────────

  it('accepts a valid x-webhook-secret', async () => {
    const res = await request(app)
      .get('/api/github/test')
      .set('x-webhook-secret', 'test-webhook-secret');
    assert.equal(res.status, 200);
  });

  it('rejects an invalid x-webhook-secret', async () => {
    const res = await request(app)
      .get('/api/github/test')
      .set('x-webhook-secret', 'wrong-secret');
    assert.equal(res.status, 401);
  });

  it('rejects a request with no auth at all', async () => {
    const res = await request(app).get('/api/github/test');
    assert.equal(res.status, 401);
  });

  it('falls back to webhook secret when JWT is invalid', async () => {
    // Invalid JWT + valid webhook secret → should succeed via webhook
    const res = await request(app)
      .get('/api/github/test')
      .set('Authorization', 'Bearer invalid-token')
      .set('x-webhook-secret', 'test-webhook-secret');
    assert.equal(res.status, 200);
  });

  it('rejects when both JWT and webhook secret are invalid', async () => {
    const res = await request(app)
      .get('/api/github/test')
      .set('Authorization', 'Bearer bad-token')
      .set('x-webhook-secret', 'bad-secret');
    assert.equal(res.status, 401);
  });

  // ── loadWebhookSecret ──────────────────────────────────────────────────────

  it('reads webhook secret from a file when present', () => {
    const tmp = path.join(os.tmpdir(), `webhook-test-${Date.now()}`);
    fs.writeFileSync(tmp, 'from-file\n');
    try {
      const secret = loadWebhookSecret(tmp, undefined);
      assert.equal(secret, 'from-file');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('falls back to env when file is absent', () => {
    const secret = loadWebhookSecret('/nonexistent/path', 'env-fallback');
    assert.equal(secret, 'env-fallback');
  });

  it('returns empty string when neither source exists', () => {
    const saved = process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    try {
      const secret = loadWebhookSecret('/nonexistent/path', undefined);
      assert.equal(secret, '');
    } finally {
      process.env.GITHUB_WEBHOOK_SECRET = saved;
    }
  });

  it('file takes priority over env fallback', () => {
    const tmp = path.join(os.tmpdir(), `webhook-test-${Date.now()}`);
    fs.writeFileSync(tmp, 'from-file');
    try {
      const secret = loadWebhookSecret(tmp, 'from-env');
      assert.equal(secret, 'from-file');
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});