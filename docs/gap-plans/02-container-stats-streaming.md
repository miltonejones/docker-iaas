# Prompt 02 — Live CPU / memory stats for containers

You are an LLM coding agent working in `miltonejones/docker-iaas` (project
**Dockyard**). Dockyard already reports disk usage prominently (host gauge +
Docker footprint via an SSE stream). It reports **no runtime metrics** — no
CPU, no memory. Your task: add per-container CPU and memory stats, streamed
live to the UI, following the exact patterns the codebase already uses for
the disk usage stream.

## Global rules you must obey

- Branch: `gap/02-container-stats` from latest `origin/main`. Never push to
  `main`. Never force-push.
- Protected files — do NOT touch any of: `Dockerfile.consumer`,
  `docker-compose.yml`, `docker-compose.ci.yml`, `Caddyfile`, `.gitignore`,
  `.github/workflows/deploy.yml`, `scripts/issue-consumer.mjs`,
  `scripts/protected-files.json`, `scripts/smoke-test-hardening.sh`.
- Do not remove the `playwright` dependency.
- Copy existing patterns; do not introduce new frameworks, event libraries,
  or state managers.

## Read these files first (in this order)

1. `server/src/usage.ts` — how the existing usage snapshot is computed.
2. `server/src/routes/system.ts` — how `/api/system/usage/stream` implements
   SSE (headers, poll loop, cleanup on client disconnect). Your stats stream
   must mirror this structure.
3. `server/src/docker.ts` — the shared `docker` (dockerode) instance.
4. `server/src/services/containers.ts` — container listing service.
5. `web/src/useSessionStream.ts` and wherever the web app consumes
   `/api/system/usage/stream` (search `usage/stream` in `web/src`) — how the
   client consumes SSE today (note: `requireAuth` accepts `?token=` because
   EventSource cannot set headers).
6. `web/src/components/Instances.tsx` and
   `web/src/components/InstanceDetail.tsx` — where stats will render.

## Docker stats background (do not guess this — it is subtle)

Dockerode exposes `container.stats({ stream: false })`, which returns one
sample of the Docker stats JSON. CPU percent is NOT a field in it. You must
compute it from deltas, exactly like `docker stats` does:

```
cpuDelta    = cpu_stats.cpu_usage.total_usage  - precpu_stats.cpu_usage.total_usage
systemDelta = cpu_stats.system_cpu_usage       - precpu_stats.system_cpu_usage
onlineCpus  = cpu_stats.online_cpus  (fall back to cpu_stats.cpu_usage.percpu_usage?.length ?? 1)
cpuPercent  = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0
```

Memory (mirror `docker stats`): `used = memory_stats.usage - (memory_stats.stats.cache ?? memory_stats.stats.inactive_file ?? 0)`
— on cgroup v2 hosts there is no `cache`; use `inactive_file`. Guard every
field access: **stopped containers return partial or zeroed stats objects**,
and `precpu_stats` is zeroed on the very first sample (your formula must
yield 0, not NaN — never emit NaN into JSON). `limit = memory_stats.limit`;
treat a limit equal to the host's total memory as "no limit" for display
purposes (send it anyway; let the client decide).

## Step-by-step instructions

### Step 1 — Service: one-shot stats collection

Create `server/src/services/stats.ts`:

1. `collectContainerStats(): Promise<ContainerStats[]>` where
   ```ts
   interface ContainerStats {
     id: string;            // full container id
     name: string;          // without leading '/'
     cpuPercent: number;    // 0-100 * nCPUs, rounded to 1 decimal
     memUsedBytes: number;
     memLimitBytes: number;
     memPercent: number;    // rounded to 1 decimal
     sampledAt: string;     // ISO timestamp
   }
   ```
2. List running containers only (`docker.listContainers()` — default is
   running-only; do NOT pass `all: true`).
3. Fetch all containers' stats **concurrently** with
   `Promise.allSettled` — one hung container must not stall the snapshot.
   Wrap each `container.stats({ stream: false })` call in a 3-second timeout
   (`AbortSignal.timeout(3000)` if dockerode supports a signal here;
   otherwise `Promise.race` with a timer). A rejected/timed-out entry is
   simply omitted from the result array — never throw the whole snapshot
   away because one container misbehaved.
4. Exclude nothing by default, but attach the labels the codebase already
   uses (`iaas.system`, `iaas.protected`) as booleans so the UI can badge
   system containers. Look at how `services/containers.ts` reads labels and
   copy that.

### Step 2 — Routes

In `server/src/routes/system.ts` (keep the same file — stats are system
telemetry, and this file already holds the SSE idiom):

1. `GET /api/system/stats` — one-shot JSON array, `requireAuth`.
2. `GET /api/system/stats/stream` — SSE, `requireAuth`. Mirror the existing
   usage stream implementation line-for-line in structure:
   - same headers (`Content-Type: text/event-stream`, `Cache-Control:
     no-cache`, `Connection: keep-alive`, flush headers),
   - poll interval from env `STATS_POLL_MS` default `5000` (define it next
     to `USAGE_POLL_MS` handling; copy that idiom),
   - `data: <json>\n\n` frames,
   - clear the interval on `req.on('close')` — copy the existing cleanup
     EXACTLY; leaking intervals is the classic bug here,
   - send one frame immediately on connect before the first interval tick
     (the usage stream does this; if it does not, add the immediate frame to
     YOUR stream only).
3. Do NOT create a stats sample per SSE client. If two browser tabs connect,
   Docker must still be polled only once per tick: implement a tiny
   module-level fan-out in `services/stats.ts` — a single `setInterval`
   started when the first subscriber attaches, stopped when the last
   detaches, with subscribers registered in a `Set<(s: ContainerStats[]) => void>`.
   This matters because `container.stats` is comparatively expensive.

### Step 3 — Web UI

1. Add types to `web/src/types.ts` mirroring `ContainerStats`.
2. Add a small hook `web/src/useStatsStream.ts` modeled on the existing SSE
   consumption (EventSource with `?token=` — find how the notification/usage
   streams pass the token and copy it; do not invent a new auth mechanism).
   The hook returns `{ stats: Map<containerId, ContainerStats>, live: boolean }`
   and marks `live: false` if no frame arrived for 3× the poll interval
   (the usage UI has a live/stale indicator — reuse its approach).
3. `web/src/components/Instances.tsx`: add two columns to the instance list —
   CPU % and Mem (used / limit, human-formatted via the existing helpers in
   `web/src/format.ts`; do NOT write a new byte formatter, one exists).
   Containers not present in the stats map (stopped, or errored sample) show
   `—`, not 0 — zero is a real measurement, absence is not.
4. `web/src/components/InstanceDetail.tsx`: show current CPU% and memory,
   plus a 60-sample rolling sparkline per metric. Implement the sparkline as
   a tiny inline SVG polyline component (~30 lines) in the component file or
   `web/src/components/Sparkline.tsx`. Do NOT add a charting library — no
   recharts, no chart.js. Keep the rolling buffer client-side in the hook.

### Step 4 — Tests

1. `server/src/services/stats.test.ts`: unit-test the CPU/memory math as a
   pure function. Refactor so the calculation is exported as
   `computeStats(raw: DockerRawStats): {cpuPercent, memUsedBytes, ...}` taking
   the raw JSON — then feed it fixtures: (a) a normal cgroup-v1 sample,
   (b) a cgroup-v2 sample without `cache`, (c) a first-sample with zeroed
   `precpu_stats` (expect cpuPercent 0, not NaN), (d) a stopped-container
   near-empty object (expect all zeros, no throw). Construct the fixtures by
   hand in the test file with realistic numbers.
2. Add a route test asserting `/api/system/stats` requires auth (follow
   `server/src/routes/authCoverage.test.ts` conventions — and add both new
   routes to that coverage test's table if it enumerates routes).
3. `web/test/`: a vitest for the stale-detection logic if you extracted it
   into a pure function (extract it so it is testable).

## Things you must NOT do

- No charting or websocket libraries. SSE + inline SVG only.
- No per-client Docker polling (Step 2.3 fan-out is mandatory).
- Do not emit `NaN`/`Infinity` in any JSON payload — `JSON.stringify` turns
  them into `null` and the UI will render garbage. Clamp and default to 0.
- Do not touch the existing usage stream's behavior.
- Do not block the stats snapshot on a single slow container.

## Acceptance criteria

1. `GET /api/system/stats` returns a JSON array with correct math (fixtures
   prove the formula).
2. `GET /api/system/stats/stream` streams frames at `STATS_POLL_MS`, sends an
   immediate first frame, polls Docker once per tick regardless of client
   count, and cleans up on disconnect.
3. Instances list shows CPU/Mem columns; detail view shows sparklines;
   stopped containers show `—`.
4. Live/stale indicator behaves like the disk gauge's.
5. `npm run typecheck`, `npm test`, `npm run lint` pass.

## Verification

```bash
npm run typecheck && npm test && npm run lint
# With Docker available:
npm run dev &   # then:
TOKEN=<login token>
curl -s "localhost:4300/api/system/stats" -H "Authorization: Bearer $TOKEN" | head -c 500
curl -sN "localhost:4300/api/system/stats/stream?token=$TOKEN" | head -c 800
```

Paste both outputs into the PR description.

## Commit and push

Commits per step (`feat(gap-02): ...`), then
`git push -u origin gap/02-container-stats` and open a PR titled
`feat: live CPU/memory stats for containers (SSE)`.
