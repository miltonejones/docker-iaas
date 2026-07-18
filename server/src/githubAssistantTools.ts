import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Anthropic from '@anthropic-ai/sdk';
import tar from 'tar-stream';
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { docker } from './docker.js';
import { getS3Client } from './minio.js';

const execFileAsync = promisify(execFile);

const GITHUB_API = 'https://api.github.com';
const MAX_ASSISTANT_FILE_BYTES = 512 * 1024;
const MAX_ASSISTANT_FILE_CHARS = 50_000;
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_PULL_FILES = 2000;
const MAX_PULL_BYTES = 200 * 1024 * 1024;
const CLONE_ROOT = process.env.GITHUB_CLONE_ROOT || path.join(process.cwd(), 'data', 'github-repos');
const GIT_TIMEOUT_MS = 5 * 60 * 1000;

/** Same env-var-then-secret-file pattern as the Anthropic key and the
 *  database master key — read fresh on every call (not cached at module
 *  load) so rotating the secret file just needs a container restart, not a
 *  code change, and a missing token never crashes startup. */
function resolveGithubToken(): string | undefined {
  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (envToken) return envToken;
  const secretFile = process.env.GITHUB_TOKEN_FILE || '/run/secrets/github_token';
  try {
    const token = fs.readFileSync(secretFile, 'utf8').trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

function githubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = resolveGithubToken();
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dockyard-ai',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function requireToken(action: string): string {
  const token = resolveGithubToken();
  if (!token) {
    throw new Error(
      `${action} requires a GitHub token. Add one at ~/.github_token (or set GITHUB_TOKEN_FILE / GITHUB_TOKEN) and restart the container.`,
    );
  }
  return token;
}

async function githubJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: githubHeaders(init?.headers as Record<string, string>) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message = `GitHub API ${res.status} for ${url}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed?.message) message = `${message}: ${parsed.message}`;
    } catch {
      if (body) message = `${message}: ${body.slice(0, 300)}`;
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

function repoOwner(owner: unknown): string {
  const value = String(owner ?? '').trim();
  if (!value || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error('owner must be a valid GitHub username or organization.');
  }
  return value;
}

function repoName(repo: unknown): string {
  const value = String(repo ?? '').trim();
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error('repo must be a valid GitHub repository name.');
  }
  return value;
}

function refOrDefault(ref: unknown): string | undefined {
  const value = typeof ref === 'string' ? ref.trim() : '';
  return value || undefined;
}

function normalizedRepoPath(value: unknown): string {
  const raw = String(value ?? '').replace(/^\/+/, '');
  if (raw.includes('..')) throw new Error('path must not contain "..".');
  return raw;
}

// ---------------------------------------------------------------------------
// Read-only: Contents API (list a directory, read one file) — no clone, no
// token required for public repos.
// ---------------------------------------------------------------------------

interface GithubContentEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size: number;
  sha: string;
}

interface GithubFileContent extends GithubContentEntry {
  content?: string;
  encoding?: string;
}

export async function listGithubRepoFiles(input: Record<string, unknown>) {
  const owner = repoOwner(input.owner);
  const repo = repoName(input.repo);
  const dirPath = normalizedRepoPath(input.path);
  const ref = refOrDefault(input.ref);
  const url = new URL(`${GITHUB_API}/repos/${owner}/${repo}/contents/${dirPath}`);
  if (ref) url.searchParams.set('ref', ref);

  const result = await githubJson<GithubContentEntry | GithubContentEntry[]>(url.toString());
  const entries = Array.isArray(result) ? result : [result];
  const visible = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_DIRECTORY_ENTRIES);
  return {
    owner,
    repo,
    path: dirPath || '/',
    ref: ref ?? null,
    entries: visible.map((entry) => ({
      name: entry.name,
      path: entry.path,
      type: entry.type,
      size: entry.type === 'file' ? entry.size : undefined,
    })),
    truncated: entries.length > MAX_DIRECTORY_ENTRIES,
  };
}

export async function readGithubFile(input: Record<string, unknown>) {
  const owner = repoOwner(input.owner);
  const repo = repoName(input.repo);
  const filePath = normalizedRepoPath(input.path);
  if (!filePath) throw new Error('path is required.');
  const ref = refOrDefault(input.ref);
  const url = new URL(`${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}`);
  if (ref) url.searchParams.set('ref', ref);

  const result = await githubJson<GithubFileContent | GithubFileContent[]>(url.toString());
  if (Array.isArray(result) || result.type !== 'file') {
    throw new Error('path must identify a regular file, not a directory.');
  }
  if (result.size > MAX_ASSISTANT_FILE_BYTES) {
    throw new Error(`File exceeds the ${MAX_ASSISTANT_FILE_BYTES / 1024} KiB assistant read limit.`);
  }
  if (result.encoding !== 'base64' || result.content === undefined) {
    throw new Error('File content was not returned in a readable encoding.');
  }
  const buf = Buffer.from(result.content, 'base64');
  if (buf.includes(0)) {
    throw new Error('path appears to be binary and cannot be read as text.');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  return {
    owner,
    repo,
    path: filePath,
    ref: ref ?? null,
    sha: result.sha,
    content: text.length > MAX_ASSISTANT_FILE_CHARS ? text.slice(0, MAX_ASSISTANT_FILE_CHARS) : text,
    truncated: text.length > MAX_ASSISTANT_FILE_CHARS,
  };
}

// ---------------------------------------------------------------------------
// Pull a whole repo (tarball) into a bucket or a running container. Public
// repos need no token; private repos resolve via the codeload redirect,
// which honors the same Authorization header.
// ---------------------------------------------------------------------------

async function downloadRepoTarball(owner: string, repo: string, ref: string | undefined): Promise<Buffer> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/tarball${ref ? `/${encodeURIComponent(ref)}` : ''}`;
  const res = await fetch(url, { headers: githubHeaders(), redirect: 'follow' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to download ${owner}/${repo} tarball: ${res.status} ${body.slice(0, 300)}`);
  }
  const arrayBuf = await res.arrayBuffer();
  if (arrayBuf.byteLength > MAX_PULL_BYTES) {
    throw new Error(`Repository tarball exceeds the ${MAX_PULL_BYTES / (1024 * 1024)} MiB pull limit.`);
  }
  return Buffer.from(arrayBuf);
}

interface ExtractedFile {
  /** Path relative to the repo root, with GitHub's "<repo>-<sha>/" tarball
   *  prefix stripped. */
  relativePath: string;
  content: Buffer;
}

async function extractTarballFiles(tarballGz: Buffer): Promise<ExtractedFile[]> {
  const zlib = await import('node:zlib');
  const tarBuf = zlib.gunzipSync(tarballGz);
  const files: ExtractedFile[] = [];
  let totalBytes = 0;

  await new Promise<void>((resolve, reject) => {
    const extract = tar.extract();
    extract.on('entry', (header, stream, next) => {
      if (header.type !== 'file') {
        stream.resume();
        next();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        // Strip the leading "<repo>-<sha>/" component every GitHub tarball entry has.
        const withoutPrefix = header.name.split('/').slice(1).join('/');
        if (!withoutPrefix) {
          next();
          return;
        }
        const content = Buffer.concat(chunks);
        totalBytes += content.length;
        if (files.length >= MAX_PULL_FILES) {
          reject(new Error(`Repository exceeds the ${MAX_PULL_FILES}-file pull limit.`));
          return;
        }
        if (totalBytes > MAX_PULL_BYTES) {
          reject(new Error(`Repository exceeds the ${MAX_PULL_BYTES / (1024 * 1024)} MiB pull limit.`));
          return;
        }
        files.push({ relativePath: withoutPrefix, content });
        next();
      });
      stream.on('error', reject);
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
    extract.end(tarBuf);
  });

  return files;
}

function guessContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html', '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.xml': 'application/xml',
    '.pdf': 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

export async function pullGithubRepoToBucket(input: Record<string, unknown>) {
  const owner = repoOwner(input.owner);
  const repo = repoName(input.repo);
  const ref = refOrDefault(input.ref);
  const bucket = String(input.bucket ?? '').trim();
  if (!bucket) throw new Error('bucket is required.');
  const prefix = normalizedRepoPath(input.prefix).replace(/\/$/, '');

  const clean = Boolean(input.clean);

  const tarball = await downloadRepoTarball(owner, repo, ref);
  const files = await extractTarballFiles(tarball);

  const s3 = getS3Client();

  // When clean is requested, delete all existing objects under the prefix first.
  if (clean) {
    let token: string | undefined;
    do {
      const list = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix || undefined,
          ContinuationToken: token,
        }),
      );
      const keys = (list.Contents || []).map((o) => o.Key).filter((k): k is string => !!k);
      if (keys.length > 0) {
        await Promise.all(
          keys.map((k) =>
            s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: k })),
          ),
        );
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  }

  for (const file of files) {
    const key = prefix ? `${prefix}/${file.relativePath}` : file.relativePath;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: file.content,
        ContentType: guessContentType(file.relativePath),
      }),
    );
  }

  return { owner, repo, ref: ref ?? null, bucket, prefix: prefix || null, filesWritten: files.length };
}

function validContainerRelativePath(value: unknown): string {
  const raw = String(value ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (raw.includes('..') || !/^[\w./-]*$/.test(raw)) {
    throw new Error('path must be an absolute container path using only letters, digits, "/", ".", "-", "_" (no "..").');
  }
  return raw;
}

async function tarFilesForContainer(files: ExtractedFile[], destPrefix: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    pack.on('data', (chunk: Buffer) => chunks.push(chunk));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);
    for (const file of files) {
      const entryName = destPrefix ? `${destPrefix}/${file.relativePath}` : file.relativePath;
      pack.entry({ name: entryName, size: file.content.length, mode: 0o644 }, file.content);
    }
    pack.finalize();
  });
}

export async function pullGithubRepoToContainer(input: Record<string, unknown>) {
  const owner = repoOwner(input.owner);
  const repo = repoName(input.repo);
  const ref = refOrDefault(input.ref);
  const id = String(input.id ?? '').trim();
  if (!id) throw new Error('id is required.');
  const destPrefix = validContainerRelativePath(input.path);

  const container = docker.getContainer(id);
  const info = await container.inspect();
  if (info.Config?.Labels?.['iaas.system']) {
    throw new Error('This container is system-managed and cannot be written to here.');
  }
  if (!info.State?.Running) {
    throw new Error('Container is not running — start it before pulling files into it.');
  }

  const clean = Boolean(input.clean);

  // When clean is requested, empty the destination directory first.
  if (clean && destPrefix) {
    const exec = await container.exec({
      Cmd: ['sh', '-c', `rm -rf /${destPrefix}/*`],
      AttachStdout: true,
      AttachStderr: true,
    });
    await exec.start({ hijack: false, stdin: false });
  }

  const tarball = await downloadRepoTarball(owner, repo, ref);
  const files = await extractTarballFiles(tarball);
  const archive = await tarFilesForContainer(files, destPrefix);
  await container.putArchive(archive, { path: '/' });

  return { owner, repo, ref: ref ?? null, id, path: `/${destPrefix}`, filesWritten: files.length, clean };
}

// ---------------------------------------------------------------------------
// Full clone + commit + push, for the assistant's write-back tools. Each
// repo gets one persistent scratch checkout under data/github-repos so
// repeated commits reuse history instead of re-cloning every time.
// ---------------------------------------------------------------------------

function cloneDirFor(owner: string, repo: string): string {
  return path.join(CLONE_ROOT, owner, repo);
}

function authenticatedCloneUrl(owner: string, repo: string): string {
  const token = resolveGithubToken();
  return token
    ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
    : `https://github.com/${owner}/${repo}.git`;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`git ${args[0]} failed: ${(e.stderr || e.stdout || e.message).trim().slice(0, 2000)}`);
  }
}

/** Clones on first use, or fetches + hard-resets to the requested ref on
 *  every subsequent call — so a stale local checkout never silently diverges
 *  from what's actually on GitHub before a commit is built on top of it. */
async function ensureCloneReady(owner: string, repo: string, ref: string | undefined): Promise<string> {
  requireToken('Cloning/committing to a repository');
  const dir = cloneDirFor(owner, repo);
  const url = authenticatedCloneUrl(owner, repo);

  if (!fs.existsSync(path.join(dir, '.git'))) {
    await fsp.mkdir(path.dirname(dir), { recursive: true });
    await fsp.rm(dir, { recursive: true, force: true });
    await git(path.dirname(dir), ['clone', url, dir]);
  } else {
    // Refresh the remote URL every time in case the token rotated.
    await git(dir, ['remote', 'set-url', 'origin', url]);
    await git(dir, ['fetch', 'origin']);
  }

  const branch = ref || (await git(dir, ['remote', 'show', 'origin'])).stdout.match(/HEAD branch: (\S+)/)?.[1] || 'main';
  await git(dir, ['checkout', branch]);
  await git(dir, ['reset', '--hard', `origin/${branch}`]);
  return dir;
}

export async function listGithubClones() {
  if (!fs.existsSync(CLONE_ROOT)) return [];
  const owners = await fsp.readdir(CLONE_ROOT, { withFileTypes: true }).catch(() => []);
  const results: { owner: string; repo: string; path: string }[] = [];
  for (const ownerEntry of owners) {
    if (!ownerEntry.isDirectory()) continue;
    const ownerDir = path.join(CLONE_ROOT, ownerEntry.name);
    const repos = await fsp.readdir(ownerDir, { withFileTypes: true }).catch(() => []);
    for (const repoEntry of repos) {
      if (!repoEntry.isDirectory()) continue;
      results.push({ owner: ownerEntry.name, repo: repoEntry.name, path: path.join(ownerDir, repoEntry.name) });
    }
  }
  return results;
}

interface CommitFileInput {
  path: string;
  content: string;
}

function commitFileList(value: unknown): CommitFileInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('files must be a non-empty array of { path, content }.');
  }
  return value.map((entry) => {
    const obj = entry as Record<string, unknown>;
    const filePath = normalizedRepoPath(obj.path);
    if (!filePath) throw new Error('Each file needs a non-empty path.');
    if (typeof obj.content !== 'string') throw new Error(`File "${filePath}" needs string content.`);
    return { path: filePath, content: obj.content };
  });
}

export async function commitAndPushGithubFiles(input: Record<string, unknown>) {
  const owner = repoOwner(input.owner);
  const repo = repoName(input.repo);
  const ref = refOrDefault(input.branch ?? input.ref);
  const message = String(input.message ?? '').trim();
  if (!message) throw new Error('message (commit message) is required.');
  const files = commitFileList(input.files);

  const dir = await ensureCloneReady(owner, repo, ref);

  for (const file of files) {
    const target = path.join(dir, file.path);
    if (path.relative(dir, target).startsWith('..')) {
      throw new Error(`File path "${file.path}" escapes the repository root.`);
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, file.content, 'utf8');
  }

  await git(dir, ['add', '--', ...files.map((f) => f.path)]);
  const status = (await git(dir, ['status', '--porcelain'])).stdout.trim();
  if (!status) {
    return { owner, repo, committed: false, reason: 'No changes to commit — file contents already match the repository.' };
  }

  await git(dir, ['-c', 'user.email=assistant@dockyard.ai', '-c', 'user.name=Dockyard Assistant', 'commit', '-m', message]);
  const branch = (await git(dir, ['branch', '--show-current'])).stdout.trim();
  await git(dir, ['push', 'origin', branch]);
  const sha = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();

  return { owner, repo, branch, committed: true, sha, filesChanged: files.map((f) => f.path) };
}

// ---------------------------------------------------------------------------
// Tool schema + wiring
// ---------------------------------------------------------------------------

export const GITHUB_ASSISTANT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_github_repo_files',
    description:
      'List files and folders at a path in a GitHub repository (read-only, runs automatically with no confirmation). Public repos need no token; private repos require a configured GitHub token. Use this before reading a file to see what exists.',
    input_schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (user or organization)' },
        repo: { type: 'string', description: 'Repository name' },
        path: { type: 'string', description: 'Directory path within the repo; omit for the repo root' },
        ref: { type: 'string', description: 'Branch, tag, or commit SHA; omit for the default branch' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'read_github_file',
    description:
      "Read one text file's content from a GitHub repository (read-only, runs automatically with no confirmation). Limited to 512 KiB and 50,000 characters; binary files cannot be read this way.",
    input_schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (user or organization)' },
        repo: { type: 'string', description: 'Repository name' },
        path: { type: 'string', description: 'File path within the repo' },
        ref: { type: 'string', description: 'Branch, tag, or commit SHA; omit for the default branch' },
      },
      required: ['owner', 'repo', 'path'],
    },
  },
  {
    name: 'pull_github_repo_to_bucket',
    description:
      "Download a GitHub repository's full contents (as of a branch/tag/commit) and write every file into a storage bucket, preserving the repo's folder structure under an optional prefix. When clean is true, all existing objects under the prefix are deleted first so stale files from a previous pull don't linger. Use this when the user wants to host or copy a whole GitHub repo into a bucket. The bucket must already exist. Requires confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (user or organization)' },
        repo: { type: 'string', description: 'Repository name' },
        ref: { type: 'string', description: 'Branch, tag, or commit SHA; omit for the default branch' },
        bucket: { type: 'string', description: 'Existing destination bucket name' },
        prefix: { type: 'string', description: 'Optional key prefix to write files under, e.g. "site/"' },
        clean: { type: 'boolean', description: 'If true, delete all existing objects under the prefix before pulling, ensuring a clean slate.' },
      },
      required: ['owner', 'repo', 'bucket'],
    },
  },
  {
    name: 'pull_github_repo_to_container',
    description:
      "Download a GitHub repository's full contents (as of a branch/tag/commit) and write every file into a running, non-system container's filesystem, preserving the repo's folder structure under the given destination directory. When clean is true, the destination directory is emptied first so stale files from a previous pull don't linger. Use this when the user wants to deploy a whole GitHub repo onto a container. Requires confirmation.",
    input_schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (user or organization)' },
        repo: { type: 'string', description: 'Repository name' },
        ref: { type: 'string', description: 'Branch, tag, or commit SHA; omit for the default branch' },
        id: { type: 'string', description: 'Target container id' },
        path: { type: 'string', description: 'Absolute destination directory inside the container, e.g. "/usr/share/nginx/html"' },
        clean: { type: 'boolean', description: 'If true, delete the destination directory contents before pulling, ensuring a clean slate.' },
      },
      required: ['owner', 'repo', 'id', 'path'],
    },
  },
  {
    name: 'commit_and_push_github_files',
    description:
      'Write one or more files into a persistent local clone of a GitHub repository, commit them, and push to the remote branch. Requires a configured GitHub token with push access. Clones the repo on first use and re-syncs to the latest remote state before every commit, so this always builds on top of the real current branch, never a stale local copy. Requires confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner (user or organization)' },
        repo: { type: 'string', description: 'Repository name' },
        branch: { type: 'string', description: 'Branch to commit to; omit for the default branch' },
        message: { type: 'string', description: 'Commit message' },
        files: {
          type: 'array',
          description: 'Files to write and commit, each with a complete replacement content',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative file path within the repo' },
              content: { type: 'string', description: 'Complete file content' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['owner', 'repo', 'message', 'files'],
    },
  },
];

export const GITHUB_ASSISTANT_READ_ONLY_TOOLS = new Set(['list_github_repo_files', 'read_github_file']);

export async function executeGithubAssistantReadOnlyTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_github_repo_files':
      return listGithubRepoFiles(input);
    case 'read_github_file':
      return readGithubFile(input);
    default:
      throw new Error(`Unknown GitHub assistant read-only tool "${name}".`);
  }
}
