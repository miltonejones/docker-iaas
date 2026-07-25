import fs from 'node:fs';
import { execFile } from 'node:child_process';

// In the container, Caddy's config is at /etc/caddy/Caddyfile.
// Outside, it's in the repo root. The env var lets tests override.
const CADDYFILE = process.env.CADDYFILE_PATH
  || (fs.existsSync('/etc/caddy/Caddyfile') ? '/etc/caddy/Caddyfile' : null)
  || 'Caddyfile';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function assertDomain(domain: string): void {
  if (!DOMAIN_RE.test(domain)) throw new Error(`Invalid domain: ${domain}`);
  if (domain.includes('\n') || domain.includes('\r') || domain.includes('{') || domain.includes('}')) {
    throw new Error(`Domain contains forbidden characters: ${domain}`);
  }
}

/** Append a reverse-proxy site block for a custom domain.  Skips if the
 *  domain already has a block (idempotent).  Validates the domain format. */
export function appendCaddySite(domain: string): void {
  assertDomain(domain);
  let content = readCaddyfile();
  if (content.includes(`${domain} {`)) return; // already present

  const block = [
    ``,
    `${domain} {`,
    `    reverse_proxy localhost:4300 {`,
    `        header_up Host ${domain}`,
    `    }`,
    `}`,
  ].join('\n');

  fs.writeFileSync(CADDYFILE, content.trimEnd() + '\n' + block + '\n', 'utf8');
}

/** Remove a site block for a custom domain.  No-op if the domain doesn't
 *  have a block. */
export function removeCaddySite(domain: string): void {
  assertDomain(domain);
  let content = readCaddyfile();
  if (!content.includes(`${domain} {`)) return;

  // Remove the block: from the line containing "domain {" through its "}"
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${domain} {`);
  if (start === -1) return;

  let depth = 0;
  let end = start;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].includes('{')) depth++;
    if (lines[i].includes('}')) {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  lines.splice(start, end - start + 1);
  fs.writeFileSync(CADDYFILE, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
}

/** Gracefully reload Caddy (zero downtime, async).  Resolves when reload
 *  completes; rejects if caddy is unavailable (e.g. local dev). */
export function reloadCaddy(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('caddy', ['reload', '--config', CADDYFILE], { timeout: 10_000 }, (err) => {
      if (err) {
        // caddy may not be installed (local dev) — degrade gracefully.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve(); // not an error — caddy just isn't available
        } else {
          reject(err);
        }
      } else {
        resolve();
      }
    });
    child.unref();
  });
}

function readCaddyfile(): string {
  try {
    return fs.readFileSync(CADDYFILE, 'utf8');
  } catch {
    return '';
  }
}
