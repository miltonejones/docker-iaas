import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import {
  isSensitiveAssistantPath,
  containsLikelySecret,
  resolveHostPath,
  validContainerPath,
} from './hostFiles.js';

// ---------------------------------------------------------------------------
// isSensitiveAssistantPath
// ---------------------------------------------------------------------------

describe('isSensitiveAssistantPath', () => {
  it('rejects .ssh paths', () => {
    assert.equal(isSensitiveAssistantPath('/home/user/.ssh/id_rsa'), true);
    assert.equal(isSensitiveAssistantPath('/root/.ssh/authorized_keys'), true);
  });

  it('rejects .env files', () => {
    assert.equal(isSensitiveAssistantPath('/app/.env'), true);
    assert.equal(isSensitiveAssistantPath('/app/.env.production'), true);
  });

  it('rejects .aws and .kube directories', () => {
    assert.equal(isSensitiveAssistantPath('/home/user/.aws/credentials'), true);
    assert.equal(isSensitiveAssistantPath('/home/user/.kube/config'), true);
  });

  it('rejects .docker and .gnupg directories', () => {
    assert.equal(isSensitiveAssistantPath('/root/.docker/config.json'), true);
    assert.equal(isSensitiveAssistantPath('/root/.gnupg/private.key'), true);
  });

  it('rejects .password-store', () => {
    assert.equal(isSensitiveAssistantPath('/home/user/.password-store/github.gpg'), true);
  });

  it('rejects a secrets directory anywhere in the path', () => {
    assert.equal(isSensitiveAssistantPath('/app/secrets/db.json'), true);
    assert.equal(isSensitiveAssistantPath('/nested/secrets/creds'), true);
  });

  it('rejects private key files by extension', () => {
    assert.equal(isSensitiveAssistantPath('/certs/server.key'), true);
    assert.equal(isSensitiveAssistantPath('/certs/ca.pem'), true);
    assert.equal(isSensitiveAssistantPath('/certs/identity.p12'), true);
    assert.equal(isSensitiveAssistantPath('/certs/bundle.pfx'), true);
  });

  it('rejects id_* named files', () => {
    assert.equal(isSensitiveAssistantPath('/home/user/.ssh/id_rsa'), true);
    assert.equal(isSensitiveAssistantPath('/home/user/.ssh/id_ed25519'), true);
    assert.equal(isSensitiveAssistantPath('/home/user/.ssh/id_ecdsa_sk'), true);
  });

  it('rejects credentials/password named files', () => {
    assert.equal(isSensitiveAssistantPath('/app/credentials'), true);
    assert.equal(isSensitiveAssistantPath('/app/passwords'), true);
    assert.equal(isSensitiveAssistantPath('/app/password'), true);
  });

  it('rejects .antro and .dockyard_database_master_key', () => {
    assert.equal(isSensitiveAssistantPath('/home/user/.antro'), true);
    assert.equal(isSensitiveAssistantPath('/run/secrets/.dockyard_database_master_key'), true);
  });

  it('allows normal files', () => {
    assert.equal(isSensitiveAssistantPath('/home/user/projects/app.ts'), false);
    assert.equal(isSensitiveAssistantPath('/var/log/nginx/access.log'), false);
    assert.equal(isSensitiveAssistantPath('/etc/nginx/nginx.conf'), false);
    assert.equal(isSensitiveAssistantPath('/tmp/data.json'), false);
  });

  it('returns false for non-string input', () => {
    assert.equal(isSensitiveAssistantPath(null), false);
    assert.equal(isSensitiveAssistantPath(undefined), false);
    assert.equal(isSensitiveAssistantPath(123), false);
    assert.equal(isSensitiveAssistantPath({}), false);
  });

  it('is case-insensitive for segment matching', () => {
    assert.equal(isSensitiveAssistantPath('/home/user/.SSH/id_rsa'), true);
    assert.equal(isSensitiveAssistantPath('/app/.ENV'), true);
    assert.equal(isSensitiveAssistantPath('/app/Secrets/creds'), true);
  });
});

// ---------------------------------------------------------------------------
// containsLikelySecret
// ---------------------------------------------------------------------------

describe('containsLikelySecret', () => {
  it('detects PEM private keys', () => {
    assert.equal(containsLikelySecret('-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----'), true);
    assert.equal(containsLikelySecret('-----BEGIN EC PRIVATE KEY-----\nxyz\n-----END EC PRIVATE KEY-----'), true);
    assert.equal(containsLikelySecret('-----BEGIN PRIVATE KEY-----\ndata\n-----END PRIVATE KEY-----'), true);
  });

  it('detects key=value secrets', () => {
    assert.equal(containsLikelySecret('API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456'), true);
    assert.equal(containsLikelySecret("api_key: 'sk-abcdefghijklmnopqrstuvwxyz123456'"), true);
    assert.equal(containsLikelySecret('password = "super-secret-value-that-is-long-enough"'), true);
    assert.equal(containsLikelySecret('secret: a1b2c3d4e5f6g7h8i9j0k1l2m3'), true);
    assert.equal(containsLikelySecret('token=ghp_1234567890abcdefghijklmnopqrstuv'), true);
  });

  it('does not flag short values', () => {
    assert.equal(containsLikelySecret('key=short'), false);
    assert.equal(containsLikelySecret('password=abc'), false);
  });

  it('does not flag normal text', () => {
    assert.equal(containsLikelySecret('console.log("hello world")'), false);
    assert.equal(containsLikelySecret('const x = 42;'), false);
    assert.equal(containsLikelySecret(''), false);
  });

  it('does not flag PEM public keys', () => {
    assert.equal(containsLikelySecret('-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----'), false);
  });
});

// ---------------------------------------------------------------------------
// validContainerPath
// ---------------------------------------------------------------------------

describe('validContainerPath', () => {
  it('accepts valid absolute paths', () => {
    assert.equal(validContainerPath('/app/config.json'), 'app/config.json');
    assert.equal(validContainerPath('/usr/local/bin/tool'), 'usr/local/bin/tool');
    assert.equal(validContainerPath('/data'), 'data');
    assert.equal(validContainerPath('/a/b/c/d/e'), 'a/b/c/d/e');
  });

  it('rejects non-absolute paths', () => {
    assert.equal(validContainerPath('relative/path'), undefined);
    assert.equal(validContainerPath('./config.json'), undefined);
    assert.equal(validContainerPath(''), undefined);
  });

  it('rejects .. traversal', () => {
    assert.equal(validContainerPath('/../etc/passwd'), undefined);
    assert.equal(validContainerPath('/app/../../root/.ssh'), undefined);
    assert.equal(validContainerPath('/foo/bar/../../../'), undefined);
  });

  it('rejects non-string input', () => {
    assert.equal(validContainerPath(null), undefined);
    assert.equal(validContainerPath(undefined), undefined);
    assert.equal(validContainerPath(123), undefined);
  });

  it('rejects paths with bad characters', () => {
    // validContainerPath regex is /^[\w./-]+$/ — no spaces, no special chars
    assert.equal(validContainerPath('/app/my file.txt'), undefined);
    assert.equal(validContainerPath('/app/;rm -rf /'), undefined);
    assert.equal(validContainerPath('/app/$(whoami)'), undefined);
    assert.equal(validContainerPath('/app/file\x00hidden'), undefined);
  });

  it('allows hyphens and underscores', () => {
    assert.ok(validContainerPath('/app/my-config_file.json'));
  });
});

// ---------------------------------------------------------------------------
// resolveHostPath — uses real filesystem, but tests path logic and traversal
// ---------------------------------------------------------------------------

describe('resolveHostPath', () => {
  it('rejects non-string input', async () => {
    await assert.rejects(() => resolveHostPath(null), /absolute/);
    await assert.rejects(() => resolveHostPath(undefined), /absolute/);
  });

  it('rejects relative paths', async () => {
    await assert.rejects(() => resolveHostPath('relative/path'), /absolute/);
    await assert.rejects(() => resolveHostPath('./foo'), /absolute/);
  });

  it('rejects .. traversal above HOST_DISK_PATH root', async () => {
    // With default HOST_DISK_PATH='/', `..` at root is a no-op.  Set a
    // subdirectory as the root so `/../etc` escapes it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockyard-test-'));
    const prev = process.env.HOST_DISK_PATH;
    process.env.HOST_DISK_PATH = dir;
    try {
      await assert.rejects(() => resolveHostPath('/../etc/passwd'), /stay within/);
    } finally {
      if (prev !== undefined) process.env.HOST_DISK_PATH = prev;
      else delete process.env.HOST_DISK_PATH;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a real absolute path under default root', async () => {
    const tmpdir = os.tmpdir();
    const result = await resolveHostPath(tmpdir);
    assert.ok(typeof result === 'string');
    assert.ok(path.isAbsolute(result));
  });

  it('resolves symlinks and rejects escapes through them', async () => {
    // Create a temp dir with a symlink that points outside, then verify
    // resolveHostPath catches it via realpath.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockyard-test-'));
    const inside = path.join(dir, 'inside');
    fs.writeFileSync(inside, 'safe', 'utf8');
    // symlink inside -> /etc (outside the test root)
    const link = path.join(dir, 'escape');
    fs.symlinkSync('/etc', link);
    try {
      // Set HOST_DISK_PATH to dir so /etc is outside the root
      const prev = process.env.HOST_DISK_PATH;
      process.env.HOST_DISK_PATH = dir;
      try {
        // sourcePath `/escape` maps to `${dir}/escape` which is a symlink to /etc
        await assert.rejects(() => resolveHostPath('/escape'), /stay within/);
      } finally {
        if (prev !== undefined) process.env.HOST_DISK_PATH = prev;
        else delete process.env.HOST_DISK_PATH;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
