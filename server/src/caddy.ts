import fs from 'node:fs';
import { execSync } from 'node:child_process';

// In the container, Caddy's config is at /etc/caddy/Caddyfile.
// Outside, it's in the repo root. The env var lets tests override.
const CADDYFILE = process.env.CADDYFILE_PATH
  || (fs.existsSync('/etc/caddy/Caddyfile') ? '/etc/caddy/Caddyfile' : null)
  || 'Caddyfile';

/** Append a reverse-proxy site block for a custom domain.  Skips if the
 *  domain already has a block (idempotent). */
export function appendCaddySite(domain: string): void {
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

/** Gracefully reload Caddy (zero downtime). */
export function reloadCaddy(): void {
  execSync(`caddy reload --config ${CADDYFILE}`, { timeout: 10_000 });
}

function readCaddyfile(): string {
  try {
    return fs.readFileSync(CADDYFILE, 'utf8');
  } catch {
    return '';
  }
}
