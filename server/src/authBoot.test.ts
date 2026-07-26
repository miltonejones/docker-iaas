// Must set before the dynamic import of auth.ts, which does process.exit(1)
// if no secret is available.
process.env.JWT_SECRET = 'dockyard-boot-test-secret';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let loadJwtSecret: typeof import('./auth.js').loadJwtSecret;

describe('JWT secret boot', () => {
  before(async () => {
    const mod = await import('./auth.js');
    loadJwtSecret = mod.loadJwtSecret;
  });

  it('reads secret from a file when present', () => {
    const tmp = path.join(os.tmpdir(), `jwt-test-${Date.now()}`);
    fs.writeFileSync(tmp, 'file-secret-value\n');
    try {
      const secret = loadJwtSecret(tmp, undefined);
      assert.equal(secret, 'file-secret-value');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('falls back to env when file is absent', () => {
    const secret = loadJwtSecret('/nonexistent/path/jwt_secret', 'env-fallback');
    assert.equal(secret, 'env-fallback');
  });

  it('returns empty string when neither source exists', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      const secret = loadJwtSecret('/nonexistent/path/jwt_secret', undefined);
      assert.equal(secret, '');
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });

  it('file takes priority over env fallback', () => {
    const tmp = path.join(os.tmpdir(), `jwt-test-${Date.now()}`);
    fs.writeFileSync(tmp, 'from-file');
    try {
      const secret = loadJwtSecret(tmp, 'from-env');
      assert.equal(secret, 'from-file');
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
