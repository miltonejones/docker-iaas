import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { docker } from './docker.js';

// In the container, Caddy's config is at /etc/caddy/Caddyfile (mounted
// read-only from the repo root).  Custom-domain site blocks are kept in a
// separate file so deploy-wipes don't lose them.
// Outside Docker (local dev), both run on the host and the env var lets tests override.
const SITES_FILE = process.env.CADDY_SITES_PATH
  || (fs.existsSync('/.dockerenv') ? 'data/sites.caddy' : 'sites.caddy');

// The path inside the Caddy container where we push the merged config.
const CADDY_CONTAINER_CONFIG = '/data/Caddyfile';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function assertDomain(domain: string): void {
  if (!DOMAIN_RE.test(domain)) throw new Error(`Invalid domain: ${domain}`);
  if (domain.includes('\n') || domain.includes('\r') || domain.includes('{') || domain.includes('}')) {
    throw new Error(`Domain contains forbidden characters: ${domain}`);
  }
}

// ── Site block management ─────────────────────────────────────────────────

/** Append a reverse-proxy site block for a custom domain.  Skips if the
 *  domain already has a block (idempotent).  Writes to SITES_FILE. */
export function appendCaddySite(domain: string): void {
  assertDomain(domain);
  let content = readSitesFile();
  if (content.includes(`${domain} {`)) return;

  const upstream = fs.existsSync('/.dockerenv') ? 'console:4300' : 'localhost:4300';

  const block = [
    ``,
    `${domain} {`,
    `    reverse_proxy ${upstream} {`,
    `        header_up Host ${domain}`,
    `    }`,
    `}`,
  ].join('\n');

  fs.writeFileSync(SITES_FILE, content.trimEnd() + '\n' + block + '\n', 'utf8');
}

/** Remove a site block for a custom domain.  No-op if the domain doesn't
 *  have a block. */
export function removeCaddySite(domain: string): void {
  assertDomain(domain);
  let content = readSitesFile();
  if (!content.includes(`${domain} {`)) return;

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
  fs.writeFileSync(SITES_FILE, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
}

// ── Caddy container helpers ───────────────────────────────────────────────

function execInCaddy(cmd: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    docker.getContainer('dockyard-caddy').exec(
      { Cmd: cmd, AttachStdout: true, AttachStderr: true },
      (err, exec) => {
        if (err) { reject(err); return; }
        exec!.start({ Detach: false, Tty: false }, (startErr, stream) => {
          if (startErr) { reject(startErr); return; }
          let stdout = '';
          stream!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
          stream!.on('end', () => resolve(stdout));
          stream!.on('error', reject);
        });
      },
    );
  });
}

let baseConfigCache: string | null = null;

async function getBaseConfig(): Promise<string> {
  if (baseConfigCache !== null) return baseConfigCache;
  try {
    baseConfigCache = (await execInCaddy(['cat', '/etc/caddy/Caddyfile'])).trimEnd();
    return baseConfigCache;
  } catch (err) {
    console.error('Failed to read base Caddyfile from Caddy container:', (err as Error).message);
    baseConfigCache = '';
    return baseConfigCache;
  }
}

function writeFileInCaddy(path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    docker.getContainer('dockyard-caddy').exec(
      {
        Cmd: ['sh', '-c', `echo '${encoded}' | base64 -d > ${path}`],
        AttachStdout: true,
        AttachStderr: true,
      },
      (err, exec) => {
        if (err) { reject(err); return; }
        exec!.start({ Detach: false, Tty: false }, (startErr, stream) => {
          if (startErr) { reject(startErr); return; }
          let stderr = '';
          stream!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
          stream!.on('end', () => {
            if (stderr.trim()) console.error('caddy write-file stderr:', stderr.trim());
            resolve();
          });
          stream!.on('error', reject);
        });
      },
    );
  });
}

/** Gracefully reload Caddy (zero downtime, async).
 *
 *  In Docker, we merge the base config from the Caddy container with the
 *  site blocks from SITES_FILE, push to a writable path, and reload.
 *
 *  Outside Docker, we call the local `caddy` CLI directly. */
export async function reloadCaddy(): Promise<void> {
  if (fs.existsSync('/.dockerenv')) {
    try {
      const baseConfig = await getBaseConfig();
      const siteBlocks = readSitesFile().trimEnd();
      const fullConfig = (baseConfig + '\n' + siteBlocks).trim() + '\n';

      await writeFileInCaddy(CADDY_CONTAINER_CONFIG, fullConfig);
      await execInCaddy(['caddy', 'reload', '--config', CADDY_CONTAINER_CONFIG]);
      return;
    } catch (err) {
      console.error('caddy reload via Docker API failed:', (err as Error).message);
      return;
    }
  }

  // Non-Docker (local dev): merge base Caddyfile + sites.caddy and reload.
  const caddyfile = process.env.CADDYFILE_PATH
    || (fs.existsSync('/etc/caddy/Caddyfile') ? '/etc/caddy/Caddyfile' : 'Caddyfile');
  const base = readCaddyfileBase(caddyfile);
  const sitesContent = readSitesFile();
  if (sitesContent.trim()) {
    fs.writeFileSync(caddyfile, (base + "\n" + sitesContent).trim() + "\n", "utf8");
    console.log("[caddy] merged " + (sitesContent.trim().split("\n{").length - 1) + " site block(s) into", caddyfile);
  }
  return new Promise((resolve, reject) => {
    const child = execFile('caddy', ['reload', '--config', caddyfile], { timeout: 10_000 }, (err) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve();
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

function readCaddyfileBase(path: string): string {
  try { return fs.readFileSync(path, 'utf8'); }
  catch { return ''; }
}

function readSitesFile(): string {
  try {
    return fs.readFileSync(SITES_FILE, 'utf8');
  } catch {
    return '';
  }
}
