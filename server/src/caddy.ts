import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { docker } from './docker.js';

// In the container, Caddy's config is at /etc/caddy/Caddyfile.
// Outside, it's in the repo root. The env var lets tests override.
const CADDYFILE = process.env.CADDYFILE_PATH
  || (fs.existsSync('/etc/caddy/Caddyfile') ? '/etc/caddy/Caddyfile' : null)
  || 'Caddyfile';

/** True when the server process itself is running inside a container. */
const inDocker = fs.existsSync('/.dockerenv');

/** The path inside the Caddy container where we write the generated config.
 *  /data is the caddy_data named volume — writable and persisted across
 *  container restarts. */
const CADDY_CONTAINER_CONFIG = '/data/Caddyfile';

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

  // Inside Docker, Caddy and the console run in separate containers on the
  // same Docker network, so the upstream must use the Docker service name.
  // Outside Docker (local dev), both run on the host and localhost works.
  const upstream = inDocker ? 'console:4300' : 'localhost:4300';

  const block = [
    ``,
    `${domain} {`,
    `    reverse_proxy ${upstream} {`,
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

// ── Caddy container helpers (Docker deployments) ─────────────────────────

/** Run a command inside the dockyard-caddy container and return stdout. */
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

/** Cached copy of the Caddy container's base config.  Read once from
 *  /etc/caddy/Caddyfile inside the Caddy container, then reused across
 *  reloads so every push includes the base site block(s). */
let baseConfigCache: string | null = null;

async function getBaseConfig(): Promise<string> {
  if (baseConfigCache !== null) return baseConfigCache;
  try {
    baseConfigCache = (await execInCaddy(['cat', '/etc/caddy/Caddyfile'])).trimEnd();
    return baseConfigCache;
  } catch (err) {
    console.error('Failed to read base Caddyfile from Caddy container:', (err as Error).message);
    baseConfigCache = ''; // don't retry — cache the empty result
    return baseConfigCache;
  }
}

/** Push a string into a file inside the dockyard-caddy container via stdin. */
function writeFileInCaddy(path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Encode as base64 to safely embed in a shell string (no escaping issues
    // with special characters in domain names or config blocks).
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
 *  In Docker, Caddy runs in a separate container ("dockyard-caddy").
 *  We merge the base config (from /etc/caddy/Caddyfile inside the Caddy
 *  container) with the locally-tracked custom-domain blocks, push the
 *  result to a writable path inside the Caddy container, and reload.
 *
 *  Outside Docker, we call the local `caddy` CLI directly.  Degrades
 *  gracefully if Caddy is unavailable (e.g. local dev). */
export async function reloadCaddy(): Promise<void> {
  if (inDocker) {
    try {
      const baseConfig = await getBaseConfig();
      const domainBlocks = readCaddyfile().trimEnd();
      const fullConfig = (baseConfig + '\n' + domainBlocks).trim() + '\n';

      await writeFileInCaddy(CADDY_CONTAINER_CONFIG, fullConfig);
      await execInCaddy(['caddy', 'reload', '--config', CADDY_CONTAINER_CONFIG]);
      return;
    } catch (err) {
      // Docker API may be unreachable (e.g. CI, tests).  Log and
      // continue — the endpoint should still succeed; the operator
      // can reload manually or restart the Caddy container.
      console.error('caddy reload via Docker API failed:', (err as Error).message);
      return;
    }
  }

  // Non-Docker (local dev): reload Caddy directly via the host CLI.
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
