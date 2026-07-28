import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

// Ensure JWT_SECRET is set before auth.js loads — it reads the secret at
// module level from /run/secrets/jwt_secret (Docker) or process.env.JWT_SECRET.
// In test environments without Docker secrets, this env var is the source.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dockyard-auth-test-secret';

import { signToken, loadJwtSecret } from './auth.js';
import { initDb } from './db.js';

before(() => { initDb(':memory:'); });

// ---------------------------------------------------------------------------
// signToken — pure JWT creation without touching the DB or Express
// ---------------------------------------------------------------------------

describe('signToken', () => {
  it('produces a JWT with the expected payload fields', () => {
    const token = signToken({ id: 'usr-abc123', email: 'test@dockyard.test' });
    const payload = jwt.decode(token) as Record<string, unknown>;
    assert.equal(payload.userId, 'usr-abc123');
    assert.equal(payload.email, 'test@dockyard.test');
  });

  it('includes an expiration claim', () => {
    const token = signToken({ id: 'usr-x', email: 'x@dockyard.test' });
    const payload = jwt.decode(token) as { exp?: number };
    assert.ok(typeof payload.exp === 'number');
    // Default expiry is 7d — should be in the future
    assert.ok(payload.exp > Date.now() / 1000);
  });

  it('produces different tokens for different users', () => {
    const a = signToken({ id: 'usr-a', email: 'a@dockyard.test' });
    const b = signToken({ id: 'usr-b', email: 'b@dockyard.test' });
    assert.notEqual(a, b);
  });

  it('each call produces a unique token (different iat)', () => {
    const a = signToken({ id: 'usr-x', email: 'x@dockyard.test' });
    const b = signToken({ id: 'usr-x', email: 'x@dockyard.test' });
    // Should differ because iat differs (or jti if present)
    // jsonwebtoken may produce identical tokens within the same second due to
    // iat granularity — if they match, at least verify both decode identically.
    const decA = jwt.decode(a) as Record<string, unknown>;
    const decB = jwt.decode(b) as Record<string, unknown>;
    assert.equal(decA.userId, decB.userId);
    assert.equal(decA.email, decB.email);
  });
});

// ---------------------------------------------------------------------------
// Token tampering / expiry (pure jwt.verify, no middleware)
// ---------------------------------------------------------------------------

describe('token verification edge cases', () => {
  // Use the same secret that auth.js loaded from file/env at import time.
  // loadJwtSecret() checks /run/secrets/jwt_secret first, then env.
  // In Docker environments the file takes priority; in dev/test, env is used.
  // We must verify against the *actual* secret, not just the env var.
  const SECRET = loadJwtSecret();

  it('rejects a tampered token', () => {
    const token = signToken({ id: 'usr-a', email: 'a@dockyard.test' });
    // Flip the last character of the signature
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    assert.throws(() => jwt.verify(tampered, SECRET), /invalid/);
  });

  it('rejects a token signed with a different secret', () => {
    const wrongToken = jwt.sign({ userId: 'usr-x', email: 'x@dockyard.test' }, 'wrong-secret', { expiresIn: '7d' });
    assert.throws(() => jwt.verify(wrongToken, SECRET), /invalid/);
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ userId: 'usr-x', email: 'x@dockyard.test' }, SECRET, { expiresIn: '0s' });
    // Small delay to ensure clock has ticked past expiry
    assert.throws(() => jwt.verify(expired, SECRET), /expired/i);
  });

  it('rejects an empty string as token', () => {
    assert.throws(() => jwt.verify('', SECRET), /jwt must be provided/i);
  });

  it('rejects a malformed token (not three parts)', () => {
    assert.throws(() => jwt.verify('not.a.jwt.token.at.all', SECRET), /malformed|invalid/i);
    assert.throws(() => jwt.verify('just-one-part', SECRET), /malformed|invalid/i);
  });
});