import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { docker } from './docker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Custom-domain site blocks are stored as individual files so that one bad
// block can't break the base site.  Caddy imports them via:
//     import /data/sites/*.caddy
// In Docker, the sites directory lives in the Caddy container's /data volume.
// The console writes files into the Caddy container via Docker exec.
const CADDY_SITES_DIR = '/data/sites';

// Local dev: write per-domain files to a local directory that Caddy imports.
const LOCAL_SITES_DIR = process.env.CADDY_SITES_PATH
  || (fs.existsSync('/.dockerenv') ? undefined : 'sites');

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function assertDomain(domain: string): void {
  if (!DOMAIN_RE.test(domain)) throw new Error(`Invalid domain: ${domain}`);
  if (domain.includes('\n') || domain.includes('\r') || domain.includes('{') || domain.includes('}')) {
    throw new Error(`Domain contains forbidden characters: ${domain}`);
  }
}

// ── Caddy container helpers ───────────────────────────────────────────────

/** Run a command inside the Caddy container and return stdout. */
function execInCaddy(cmd: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    docker.getContainer('dockyard-caddy').exec(
      { Cmd: cmd, AttachStdout: true, AttachStderr: true },
      (err, exec) => {
        if (err) { reject(err); return; }
        exec!.start({ Detach: false, Tty: true }, (startErr, stream) => {
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

/** Write content to a path inside the Caddy container (base64-encoded to avoid
 *  shell escaping issues). */
function writeFileInCaddy(containerPath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    // Ensure the parent directory exists first.
    const dir = path.posix.dirname(containerPath);
    const mkdir = `mkdir -p ${dir}`;
    const write = `echo '${encoded}' | base64 -d > ${containerPath}`;
    docker.getContainer('dockyard-caddy').exec(
      { Cmd: ['sh', '-c', `${mkdir} && ${write}`], AttachStdout: true, AttachStderr: true },
      (err, exec) => {
        if (err) { reject(err); return; }
        exec!.start({ Detach: false, Tty: true }, (startErr, stream) => {
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

/** Delete a file inside the Caddy container. */
function deleteFileInCaddy(containerPath: string): Promise<void> {
  return execInCaddy(['sh', '-c', `rm -f '${containerPath}'`]).then(() => {});
}

// ── Site block management ─────────────────────────────────────────────────

function makeBlock(domain: string): string {
  const upstream = fs.existsSync('/.dockerenv') ? 'console:4300' : 'localhost:4300';
  return [
    `${domain} {`,
    `    reverse_proxy ${upstream} {`,
    `        header_up Host ${domain}`,
    `    }`,
    `}`,
  ].join('\n') + '\n';
}

function siteFilePath(domain: string): string {
  return `/data/sites/${domain}.caddy`;
}

function localSiteFilePath(domain: string): string {
  return path.join(LOCAL_SITES_DIR!, `${domain}.caddy`);
}

/** Append a reverse-proxy site block for a custom domain (idempotent).
 *  In Docker, writes the per-domain file into the Caddy container.
 *  Locally, writes to the local sites directory. */
export async function appendCaddySite(domain: string): Promise<void> {
  assertDomain(domain);
  const block = makeBlock(domain);

  if (fs.existsSync('/.dockerenv')) {
    // Docker: write into the Caddy container.
    await writeFileInCaddy(siteFilePath(domain), block);
  } else {
    fs.mkdirSync(LOCAL_SITES_DIR!, { recursive: true });
    fs.writeFileSync(localSiteFilePath(domain), block, 'utf8');
  }
}

/** Remove a site block for a custom domain.  No-op if not present. */
export async function removeCaddySite(domain: string): Promise<void> {
  assertDomain(domain);

  if (fs.existsSync('/.dockerenv')) {
    // Check if the file exists first (idempotent).
    const exists = await execInCaddy(['sh', '-c', `test -f '${siteFilePath(domain)}' && echo yes || echo no`]);
    if (!exists.trim().startsWith('yes')) return;
    await deleteFileInCaddy(siteFilePath(domain));
  } else {
    const file = localSiteFilePath(domain);
    if (!fs.existsSync(file)) return;
    fs.unlinkSync(file);
  }
}

// ── Reload ────────────────────────────────────────────────────────────────

/** Gracefully reload Caddy (zero downtime).
 *
 *  In Docker: just reload — Caddy picks up per-domain files via the
 *  `import /data/sites/*.caddy` directive in the base Caddyfile.
 *  The base config is never touched, so a bad custom-domain block
 *  can't break dockyard-ai.com.
 *
 *  Outside Docker: reload the local Caddy instance. */
export async function reloadCaddy(): Promise<void> {
  if (fs.existsSync('/.dockerenv')) {
    try {
      await execInCaddy(['caddy', 'reload', '--config', '/etc/caddy/Caddyfile']);
    } catch (err) {
      console.error('caddy reload via Docker API failed:', (err as Error).message);
    }
    return;
  }

  // Non-Docker (local dev).
  const caddyfile = process.env.CADDYFILE_PATH
    || (fs.existsSync('/etc/caddy/Caddyfile') ? '/etc/caddy/Caddyfile' : 'Caddyfile');
  return new Promise((resolve, reject) => {
    const child = execFile('caddy', ['reload', '--config', caddyfile], { timeout: 10_000 }, (err) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') resolve();
        else reject(err);
      } else {
        resolve();
      }
    });
    child.unref();
  });
}
