import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// The databaseManagement module's `encryptConfig` / `decryptConfig` are
// private.  We test the underlying AES-256-GCM primitives directly to verify
// the cryptography (same algorithm, same key derivation via SHA-256).
//
// The public `serializeConnectionForStorage` round-trip can be tested once
// an in-memory DB + master key env var are wired in a future HTTP-level test.
// ---------------------------------------------------------------------------

describe('AES-256-GCM encrypt/decrypt (standalone)', () => {
  const key = crypto.createHash('sha256').update('test-master-key').digest();

  it('round-trips plaintext', () => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = JSON.stringify({ host: 'db.example.com', password: 's3cret!' });
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const result = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

    assert.equal(result, plaintext);
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const plaintext = 'same data';
    const c1 = (() => {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([c.update(plaintext, 'utf8'), c.final()]).toString('base64');
    })();
    const c2 = (() => {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([c.update(plaintext, 'utf8'), c.final()]).toString('base64');
    })();
    assert.notEqual(c1, c2);
  });

  it('decryption fails with wrong key', () => {
    const wrongKey = crypto.createHash('sha256').update('wrong-key').digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update('secret', 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const decipher = crypto.createDecipheriv('aes-256-gcm', wrongKey, iv);
    decipher.setAuthTag(tag);
    assert.throws(() => {
      decipher.update(ciphertext);
      decipher.final();
    });
  });

  it('decryption fails with tampered ciphertext', () => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update('secret', 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    ciphertext[0] ^= 0x01;

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    assert.throws(() => {
      decipher.update(ciphertext);
      decipher.final();
    });
  });

  it('decryption fails with tampered auth tag', () => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update('secret', 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    tag[0] ^= 0x01;

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    assert.throws(() => {
      decipher.update(ciphertext);
      decipher.final();
    });
  });
});
