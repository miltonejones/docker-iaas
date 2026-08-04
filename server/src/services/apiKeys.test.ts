import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// The server has a module-level JWT_SECRET guard in auth.ts that exits the
// process if neither the secret file nor env var are set.  Tests must set it
// before auth.ts loads.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dockyard-test-secret-dky';

import { initDb, createUser, getUserByEmail } from '../db.js';
import * as apiKeys from './apiKeys.js';

before(() => {
  initDb(':memory:');
  // Create a test user so authenticate() has a real user to look up.
  createUser('test@dockyard.test', 'hashed-pw-placeholder');
});

function getTestUserId(): string {
  const u = getUserByEmail('test@dockyard.test');
  assert.ok(u, 'test user should exist');
  return u!.id;
}

describe('apiKeys', () => {
  describe('create and authenticate round-trip', () => {
    it('creates a key and authenticates it', () => {
      const userId = getTestUserId();
      const created = apiKeys.create(userId, 'test-key');
      assert.ok(created.key.startsWith('dky_'), 'key should start with dky_ prefix');
      assert.equal(created.name, 'test-key');
      assert.ok(created.id.startsWith('key-'), 'id should start with key- prefix');

      const authResult = apiKeys.authenticate(created.key);
      assert.ok(authResult, 'should authenticate successfully');
      assert.equal(authResult!.userId, userId);
      assert.equal(authResult!.email, 'test@dockyard.test');
    });

    it('returns undefined for a bogus key', () => {
      const result = apiKeys.authenticate('dky_bogus_key_that_does_not_exist_at_all');
      assert.equal(result, undefined);
    });
  });

  describe('revocation', () => {
    it('revoked key no longer authenticates', () => {
      const userId = getTestUserId();
      const created = apiKeys.create(userId, 'key-to-revoke');

      // Verify it works before revocation.
      assert.ok(apiKeys.authenticate(created.key));

      // Revoke and verify it stops working.
      apiKeys.revoke(userId, created.id);
      assert.equal(apiKeys.authenticate(created.key), undefined);
    });

    it('revoking a non-existent key throws 404', () => {
      const userId = getTestUserId();
      assert.throws(
        () => apiKeys.revoke(userId, 'key-nonexistent'),
        (err: Error & { status?: number }) => err.status === 404,
      );
    });

    it('revoking another user key returns 404 (not 403)', () => {
      const userId = getTestUserId();
      createUser('other@dockyard.test', 'hashed-pw-2');
      const userB = getUserByEmail('other@dockyard.test')!;

      const keyA = apiKeys.create(userId, 'user-a-key');
      assert.throws(
        () => apiKeys.revoke(userB.id, keyA.id),
        (err: Error & { status?: number }) => err.status === 404,
      );
    });
  });

  describe('list', () => {
    it('returns keys for a user without the hash', () => {
      const userId = getTestUserId();
      apiKeys.create(userId, 'list-test-1');
      apiKeys.create(userId, 'list-test-2');

      const keys = apiKeys.list(userId);
      assert.ok(keys.length >= 2);
      for (const k of keys) {
        assert.ok(k.name, 'should have a name');
        assert.ok(k.key_prefix, 'should have a key_prefix');
        assert.ok(!('key_hash' in k), 'should NOT expose key_hash');
      }
    });
  });

  describe('create validation', () => {
    it('throws 400 for empty name', () => {
      const userId = getTestUserId();
      assert.throws(
        () => apiKeys.create(userId, ''),
        (err: Error & { status?: number }) => err.status === 400,
      );
      assert.throws(
        () => apiKeys.create(userId, '   '),
        (err: Error & { status?: number }) => err.status === 400,
      );
    });
  });
});
