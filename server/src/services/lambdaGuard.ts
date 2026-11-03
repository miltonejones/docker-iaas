import { docker } from '../docker.js';

// Guards around Lambda container execution — a public gateway route with no
// method/path restriction (a "catch-all") invokes the target function for
// every request that hits it, and each invocation spins up a brand-new
// Docker container (see runLambda in lambda.ts). With no limits, a burst of
// distinct-path requests (e.g. a vulnerability scanner probing for exposed
// secrets) can spawn dozens of containers in seconds, exhausting host CPU
// and leaving orphaned containers behind. These guards cap that blast radius
// without needing a new dependency — this is a single-process app, so
// in-memory state is sufficient.

// ── Per-IP rate limiting ────────────────────────────────────────

const RATE_LIMIT_MAX = Number(process.env.LAMBDA_RATE_LIMIT_MAX) || 20;
const RATE_LIMIT_WINDOW_MS = Number(process.env.LAMBDA_RATE_LIMIT_WINDOW_MS) || 10_000;

const requestLog = new Map<string, number[]>();

/** Returns true if `ip` is still within its request budget for the current
 *  sliding window; false if it should be rejected. Records the request
 *  either way so the window keeps sliding. */
export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;

  const timestamps = (requestLog.get(ip) || []).filter((t) => t > cutoff);
  const allowed = timestamps.length < RATE_LIMIT_MAX;
  timestamps.push(now);
  requestLog.set(ip, timestamps);

  // Opportunistically prune other IPs' expired entries so the map doesn't
  // grow unbounded under a distributed scan (many source IPs, few requests
  // each). Cheap relative to request volume since it only scans, no I/O.
  if (requestLog.size > 1000) {
    for (const [key, times] of requestLog) {
      const fresh = times.filter((t) => t > cutoff);
      if (fresh.length === 0) requestLog.delete(key);
      else if (fresh.length !== times.length) requestLog.set(key, fresh);
    }
  }

  return allowed;
}

// ── Concurrency cap on container spin-up ────────────────────────

const MAX_CONCURRENT = Number(process.env.LAMBDA_MAX_CONCURRENT) || 8;
const ACQUIRE_TIMEOUT_MS = 2_000;

let inFlight = 0;
const waiters: Array<() => void> = [];

/** Acquire a slot to run a Lambda container. Resolves with a release
 *  function once a slot is available; rejects if none frees up within
 *  ACQUIRE_TIMEOUT_MS (fail fast under load rather than queuing
 *  indefinitely). */
export function acquireLambdaSlot(): Promise<() => void> {
  const release = (): void => {
    inFlight--;
    const next = waiters.shift();
    if (next) next();
  };

  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return Promise.resolve(release);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = waiters.indexOf(tryAcquire);
      if (idx !== -1) waiters.splice(idx, 1);
      reject(new Error('Lambda executor is at capacity. Try again shortly.'));
    }, ACQUIRE_TIMEOUT_MS);

    function tryAcquire(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inFlight++;
      resolve(release);
    }

    waiters.push(tryAcquire);
  });
}

// ── Orphan reaper ────────────────────────────────────────────────

const REAP_INTERVAL_MS = 60_000;
const REAP_GRACE_MS = 30_000;

type DockerLike = Pick<typeof docker, 'listContainers' | 'getContainer'>;

/** Safety net independent of the per-request create/start/remove path: any
 *  container labeled iaas.ephemeral=lambda that is NOT currently running
 *  (stuck Created, Exited, Dead) and is older than a grace period gets
 *  force-removed. State-based rather than age-based so it never touches a
 *  container that's still legitimately executing. `client` is injectable
 *  for tests; defaults to the real shared Docker client. */
export async function reapOrphanedLambdaContainers(client: DockerLike = docker): Promise<number> {
  const containers = await client.listContainers({
    all: true,
    filters: { label: ['iaas.ephemeral=lambda'] },
  });

  const now = Date.now();
  let reaped = 0;
  for (const c of containers) {
    if (c.State === 'running') continue;
    const ageMs = now - c.Created * 1000;
    if (ageMs < REAP_GRACE_MS) continue;
    try {
      await client.getContainer(c.Id).remove({ force: true, v: true });
      reaped++;
    } catch {
      // Already removed by the normal cleanup path — fine.
    }
  }
  return reaped;
}

let reaperStarted = false;

/** Idempotent — safe to call multiple times (e.g. from tests); only the
 *  first call schedules the interval. */
export function startLambdaReaper(): void {
  if (reaperStarted) return;
  reaperStarted = true;
  setInterval(() => {
    reapOrphanedLambdaContainers().catch((err) => {
      console.error('Lambda reaper failed:', err);
    });
  }, REAP_INTERVAL_MS).unref();
}

/** Test-only: reset module state between test cases. */
export function _resetForTest(): void {
  requestLog.clear();
  inFlight = 0;
  waiters.length = 0;
  reaperStarted = false;
}
