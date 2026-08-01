# Prompt 07 — End-to-end integration tests against a real Docker daemon

You are an LLM coding agent working in `miltonejones/docker-iaas` (project
**Dockyard**). This is the most detailed prompt in the library. Read it
completely — twice — before writing any code. Follow it literally. Where it
says "exactly", it means exactly.

## Why this task exists (context you must internalize)

Dockyard's server tests are unit/route tests: supertest against
`createApp()` with the Docker-facing layers unavailable or mocked. But
Dockyard's riskiest code is precisely the code that talks to the real
world and **cannot** be validated by unit tests:

- container lifecycle (launch from preset, pull image, start/stop/restart/
  remove, logs) via dockerode,
- MinIO provisioning on first boot (`server/src/minio.ts` — Dockyard creates
  and manages its own MinIO container) and bucket/object CRUD through it,
- lambda function execution (Dockyard builds a tar of function files, runs a
  container, captures stdout, enforces a 30 s timeout),
- gateway routes (`/gw/<name>/...`): bucket static serving, full reverse
  proxy to a container, lambda proxy invocation with the AWS API Gateway
  event contract,
- network reconciliation (`dockyard-net` creation and reattachment),
- disk-usage snapshots from the engine's `system/df`.

An autonomous AI agent (the issue consumer) regularly edits this codebase
and CI auto-deploys `main` to a real host. A regression in any of the above
ships to production unless a test with a **real Docker daemon** catches it
first. GitHub's `ubuntu-latest` runners have a working Docker daemon out of
the box, so this is entirely feasible in CI. That is what you will build.

## Global rules you must obey

- Branch: `gap/07-e2e-tests` from latest `origin/main`. Never push to
  `main`. Never force-push.
- **Protected-file rule:** you must NOT touch `.github/workflows/deploy.yml`
  (or any other protected file: `Dockerfile.consumer`, `docker-compose.yml`,
  `docker-compose.ci.yml`, `Caddyfile`, `.gitignore`,
  `scripts/issue-consumer.mjs`, `scripts/protected-files.json`,
  `scripts/smoke-test-hardening.sh`). Instead you will create a **NEW**
  workflow file, `.github/workflows/e2e.yml` (Step 6). Adding a new workflow
  file is allowed; editing the protected one is not. A follow-up (human
  decision) may later make `deploy.yml`'s deploy job depend on the e2e
  workflow; note that as future work in your PR description — do not do it.
- Do not remove the `playwright` dependency.
- No new test frameworks. The server already uses `node:test`
  (`node --import tsx --test`). E2E tests use the same runner. No jest, no
  mocha, no vitest on the server side.
- One new dependency maximum, only if needed: none is expected —
  `supertest` is already present, `dockerode` is already present, and plain
  `fetch` (Node 22 global) covers HTTP. Do not add axios.

## Design overview (what you are building)

```
server/
  test-e2e/                      # NEW directory — e2e tests live here,
    helpers.ts                   # NOT under src/, so the unit-test glob
    01-boot.e2e.ts               # (src/*.test.ts) never picks them up
    02-containers.e2e.ts
    03-buckets.e2e.ts
    04-lambda.e2e.ts
    05-gateway.e2e.ts
    06-usage.e2e.ts
    fixtures/
      hello.txt
      lambda-node-echo/index.js
      lambda-python-echo/index.py
      lambda-broken/index.js
.github/workflows/e2e.yml        # NEW workflow
```

Execution model — decide nothing, this is the decision:

- The e2e suite runs the **server in-process** (import `createApp()` and
  `app.listen(0)` on an ephemeral port) against the **runner's real Docker
  daemon**. It does NOT build/run the Dockyard docker image itself — the
  existing `smoke-test-hardening.sh` already covers image boot; e2e covers
  API-against-real-daemon behavior. In-process means: real dockerode calls,
  real MinIO container, real function containers, real network — but
  breakpointable locally and no image build in the loop.
- Every Docker resource the suite creates is labeled
  `dockyard-e2e=true` and named with the prefix `e2e-<runId>-` where
  `runId` is 6 random hex chars generated once per suite run. Cleanup
  targets labels/prefixes, never "all containers" — a developer's local
  daemon must survive a test run unscathed.
- Tests are **serial** (node:test default within one file; run files
  sequentially with `--test-concurrency=1`) because they share one daemon
  and one server instance. Do not parallelize; interleaved pulls and prunes
  cause flakes.

## Step-by-step instructions

### Step 1 — Test scripts and isolation plumbing

1. In `server/package.json` add:
   ```json
   "test:e2e": "node --import tsx --test --test-concurrency=1 test-e2e/*.e2e.ts"
   ```
   Confirm the existing `"test"` glob (`src/*.test.ts src/**/*.test.ts`)
   cannot match `test-e2e/` — that separation is the point: `npm test` must
   remain fast and daemon-free.
2. In the ROOT `package.json` add
   `"test:e2e": "npm --workspace server run test:e2e"`.
3. The server reads configuration from env at import time in several modules.
   For the e2e process set, in `helpers.ts` BEFORE importing anything from
   `../src/`:
   - `process.env.JWT_SECRET = 'e2e-test-secret'`
   - `process.env.PORT = '0'` (not actually used — you call `listen(0)`)
   - a temp data directory: the SQLite file path — find how `db.ts` resolves
     its path (search the constructor); if it honors an env var, point it at
     a per-run temp dir under `os.tmpdir()`; if it does not, add one
     (`DOCKYARD_DATA_DIR`, defaulting to current behavior — a small,
     backwards-compatible change to `db.ts`, done carefully and covered by a
     unit test).
   - `process.env.USAGE_POLL_MS = '1000'` to make stream tests fast.

### Step 2 — `helpers.ts` (write this first; every test imports it)

Export, at minimum:

1. `startServer(): Promise<{ baseUrl, token, docker, runId, stop() }>`
   - generates `runId`,
   - prepares the temp data dir,
   - imports `createApp()` (dynamic `await import('../src/index.js')` AFTER
     env setup),
   - `listen(0)`, reads the bound port,
   - registers a user via the real `/api/auth` endpoints and logs in to get
     a JWT (do not mint tokens by hand — exercising signup/login for real is
     part of the coverage; if registration requires special seeding, read
     `server/src/routes/auth.ts` and do what a first-boot user would do),
   - constructs a `dockerode` instance the same way `server/src/docker.ts`
     does,
   - `stop()` closes the HTTP server AND runs `cleanupDockerResources()`.
2. `api(method, path, { token, body?, raw? })` — thin `fetch` wrapper that
   throws on unexpected status with the response body in the error message
   (flake diagnosis depends on this; never swallow bodies).
3. `waitFor(predicate, { timeoutMs, intervalMs, label })` — poll helper.
   EVERY wait in the suite goes through this; no bare `setTimeout` sleeps.
   On timeout it throws `Timed out after <ms> waiting for: <label>`.
4. `cleanupDockerResources(docker, runId)` — remove (force) all containers
   with label `dockyard-e2e=true` OR name prefix `e2e-<runId>-`, then all
   such networks/volumes. Also always attempt removal of the MinIO container
   IF AND ONLY IF the suite created it (Step 3 records whether MinIO existed
   before). Wrap each removal in try/catch; cleanup must never throw.
5. `label()` — returns the standard labels object
   `{ 'dockyard-e2e': 'true' }` for anything created via the API where the
   API allows labels; where the API does not accept labels (e.g. launching
   from a preset), rely on the name prefix and extend cleanup accordingly.
6. Register a global `after` (and a `process.on('exit')` best-effort log)
   for cleanup so a mid-suite crash does not strand containers on the CI
   runner.

Pin small images inside helpers as constants:
`IMAGE_ECHO = 'busybox:1.36'`, `IMAGE_HTTP = 'nginx:1.27-alpine'` — tests
must only ever pull these two tiny images plus the runtime images the lambda
service itself pins (`node:20-alpine`, `python:3.12-slim`, `alpine:latest` —
read `server/src/services/lambda.ts` RUNTIMES). Do not use `:latest` for
anything you choose yourself.

### Step 3 — `01-boot.e2e.ts` — server boot, network, MinIO provisioning

Test, in order, in one file:

1. Before starting the server: record whether a container named
   `dockyard-minio` and a network named `dockyard-net` already exist
   (`docker.listContainers({all:true})`, `listNetworks`). Store as
   `preExisting` — cleanup must not delete resources it did not create.
2. Start the server (helpers). Assert `GET /api/system/ping` reports the
   daemon reachable and an engine version string.
3. Assert the `dockyard-net` network now exists.
4. Call whatever the boot path uses for MinIO (`ensureMinio` runs in the
   listen callback in production; in-process you must invoke it explicitly —
   import `ensureMinio` from `../src/minio.js` and await it). Then assert:
   - a `dockyard-minio` container exists and is running,
   - it carries the `iaas.system=minio` label (README documents this),
   - `GET /api/buckets` returns 200 with an array (MinIO credentials were
     generated, persisted, and used).
5. Idempotency: call `ensureMinio()` a second time; assert it does NOT
   create a second container (count containers named `dockyard-minio`
   before/after).

### Step 4 — the remaining test files, scenario by scenario

**`02-containers.e2e.ts` — lifecycle.** Scenarios, serially:

1. Launch a container via `POST /api/containers` with an explicit tiny
   image (`IMAGE_ECHO`, command that stays alive: `sleep 300` — check the
   launch API's shape in `server/src/routes/containers.ts` for how
   image/cmd/name are passed; use name `e2e-<runId>-lifecycle`). Assert 2xx
   and that the response carries an id.
2. `GET /api/containers` — the new container appears with state running.
   Use `waitFor` (state transitions are not instant).
3. Logs: launch a second container that prints a marker
   (`sh -c "echo E2E_MARKER_<runId>; sleep 300"`), then `GET
   /api/containers/:id/logs` and assert the marker appears (waitFor — log
   delivery can lag).
4. `POST .../stop` → state exited (waitFor). `POST .../start` → running.
   `POST .../restart` → running with a fresh StartedAt (inspect via
   dockerode and compare timestamps).
5. `DELETE /api/containers/:id?force=true` → gone from the list.
6. Negative: `POST /api/containers` with image
   `dockyard-e2e-nonexistent-image:1.0` must produce a clean API error
   (4xx/5xx JSON with an `error` string), not a hang — wrap in a 60 s
   `waitFor`-style timeout and fail with a clear message if it hangs, since
   "pull failure hangs the API" is a realistic regression this suite exists
   to catch.
7. Preset launch: `GET /api/system/presets`, pick the smallest OS preset
   (find BusyBox/Alpine in the response), launch it by `presetId`, assert
   running, remove it. This exercises the preset → pull → create path that
   the gallery UI uses.

**`03-buckets.e2e.ts` — MinIO-backed object store.**

1. `POST /api/buckets` name `e2e-<runId>-b1` → 2xx; listed.
2. Upload via `PUT /api/buckets/:name/objects/hello.txt` with a text body;
   download it back (this route is the auth-exempt one — assert it works
   WITHOUT a token, and put a comment in the test noting this asserts
   current, known-questionable behavior so the test will be intentionally
   updated when signed URLs land).
3. Binary round-trip: upload 1 MiB of `crypto.randomBytes`, download,
   compare byte-for-byte (Buffer.equals). Content-Type preserved if the API
   supports it.
4. Prefix listing: upload `a/1.txt`, `a/2.txt`, `b/3.txt`; list with
   `?prefix=a/` → exactly two keys.
5. Delete object → 404 on subsequent download (or the API's documented
   miss behavior — read the route and assert what it actually promises).
6. Delete non-empty bucket → clean error; delete after emptying → 2xx and
   gone from list.

**`04-lambda.e2e.ts` — function execution.**

1. Create a Node function (files from `fixtures/lambda-node-echo/`:
   `index.js` = `console.log(JSON.stringify({ok:true, echo: process.env.E2E_INPUT || null}))`),
   run it via the run endpoint, assert stdout parses and `ok === true`,
   exitCode 0, durationMs > 0.
2. Same for Python (`print(json.dumps(...))`).
3. Env vars: set a function env var through the API, run, assert echoed.
4. Broken function (`fixtures/lambda-broken/index.js` =
   `process.exit(3)` after printing garbage): assert nonzero exit code is
   reported and the API returns a structured result, not a 500.
5. Timeout: create a Node function with `setTimeout(()=>{}, 120000)` keeping
   the loop alive; run it; assert the service enforces its 30 s cap
   (`TIMEOUT_MS` in `server/src/services/lambda.ts`) — total wall time of
   the request must be under ~45 s and the result must indicate
   timeout/kill. This test is slow by nature; mark it with node:test's
   long-timeout option (set the test's `timeout` to 90_000 explicitly).
6. After each run, assert no function container is left behind
   (list containers, none matching the function-run naming pattern — read
   the lambda service to learn the naming/labeling it uses for run
   containers).

**`05-gateway.e2e.ts` — all three target types, real traffic.**

1. Bucket route: create bucket `e2e-<runId>-site`, upload `index.html`
   (`<h1>e2e</h1>`) and `assets/x.txt`; create gateway route
   `{ name: 'e2e<runId>site', targetType: 'bucket', targetId: <bucket> }`;
   then `GET /gw/e2e<runId>site/` (unauthenticated — the gateway is public
   by design) → 200, body contains `<h1>e2e</h1>`; `GET .../assets/x.txt` →
   its content; `GET .../missing.txt` → 404.
2. Container route: launch `IMAGE_HTTP` (nginx) with no published port —
   the gateway proxies over the shared docker network; create route
   targetType `container`, targetPort 80; `GET /gw/<name>/` → 200 and nginx
   default page markers. Then POST with a body to a path and assert nginx
   answers 405 — proving method+body pass through.
3. Lambda route: create a function that echoes the API-Gateway event back
   (`fixtures` file reading `process.env.DOCKYARD_REQUEST`, responding
   `{statusCode:200, headers:{'x-e2e':'1'}, body: <the event JSON>}` — the
   README's Gateway section documents the exact contract; follow it).
   Request `GET /gw/<name>/a/b?x=1&y=2` with header `x-test: abc`; parse the
   echoed event and assert: `httpMethod === 'GET'`, `path` reflects the
   sub-path, `queryStringParameters` has x and y, headers include `x-test`,
   `isBase64Encoded` is boolean. Assert the response carried `x-e2e: 1`.
4. Lambda malformed response: function printing `not json` → gateway must
   answer **502** (documented "malformed Lambda proxy response" behavior).
5. Telemetry: after the above traffic, `GET
   /api/gateway/traffic/summary?windowHours=1` (with token) shows the three
   routes with plausible counts (≥ the requests you made, statuses
   partitioned into success/4xx/5xx buckets you can predict exactly — count
   your own requests and assert exact numbers; if another test file's
   traffic could interfere, filter by `gatewayName`).
6. Route deletion: delete each route → `GET /gw/<name>/` now 404, and (per
   the telemetry design) the miss is recorded with an errorClassification.

**`06-usage.e2e.ts` — disk usage and SSE.**

1. `GET /api/system/usage` → snapshot with host disk (used/free/total all
   positive, used+free ≤ total with slack) and docker df sections present.
2. SSE: open `GET /api/system/usage/stream?token=<jwt>` with fetch, read the
   stream manually, assert ≥ 2 `data:` frames arrive within 5 s
   (USAGE_POLL_MS=1000 from Step 1), each parsing as JSON; then abort the
   request and — this is the important half — assert the server does not
   crash and a subsequent one-shot usage call still works (interval cleanup
   on disconnect).

### Step 5 — Flake policy and diagnostics (build these in from the start)

1. Every `waitFor` has a `label`. Every assertion on an API response that
   fails must print the full response body (the `api` helper guarantees it).
2. On ANY test failure, an `after` hook in each file dumps to stderr:
   `docker ps -a` filtered to the run's resources, and the last 50 lines of
   each such container's logs. Implement once in helpers
   (`dumpDockerDiagnostics(docker, runId)`), call from each file's `after`.
3. Time budget: the whole suite must finish in under 10 minutes on a GitHub
   runner (the timeout test alone costs ~35 s; image pulls dominate the
   rest — the pinned images total < 100 MB). If you find the suite
   exceeding this, the fix is fewer/smaller images or reused containers —
   NEVER `--test-concurrency` > 1.
4. Zero tolerance for `sleep`-and-hope: any fixed sleep longer than 250 ms
   in the diff is a defect; use `waitFor`.

### Step 6 — CI workflow (`.github/workflows/e2e.yml` — NEW file)

```yaml
name: E2E (real Docker)

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: e2e-${{ github.ref }}
  cancel-in-progress: true

jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Pre-pull pinned images
        run: |
          docker pull busybox:1.36 &
          docker pull nginx:1.27-alpine &
          docker pull node:20-alpine &
          docker pull python:3.12-slim &
          docker pull alpine:latest &
          docker pull minio/minio:latest || true &
          wait
      - name: Run e2e suite
        run: npm run test:e2e
        env:
          JWT_SECRET: e2e-ci-secret
      - name: Docker state on failure
        if: failure()
        run: |
          docker ps -a
          docker network ls
          docker volume ls
```

Pedantic notes you must respect:

- Check `server/src/minio.ts` for the EXACT MinIO image reference it pulls
  and pre-pull that exact reference (the `minio/minio:latest || true` line
  above is a placeholder — replace it with the real pinned ref from the
  code; if the code pulls `:latest`, keep `|| true` so a Docker Hub hiccup
  does not fail the pre-pull step, and note in the PR that pinning MinIO in
  `minio.ts` would be a good follow-up).
- This workflow is separate from `deploy.yml` on purpose (protected file).
  It runs on PRs and on `main` pushes, so a red e2e on `main` is visible
  even though it cannot yet block the deploy job. Recommend — in the PR
  description only — that a human later add `e2e` to the deploy job's
  `needs:`.

### Step 7 — Local developer experience

Add `server/test-e2e/README.md` (short): prerequisites (local Docker daemon,
nothing else), the command (`npm run test:e2e`), the isolation guarantees
(labels/prefix, what cleanup removes, what it never touches), the note that
the suite creates/removes a `dockyard-minio` container only if one did not
already exist, and the flake policy ("a flaky e2e test is a bug — file an
issue with the diagnostics dump").

## Things you must NOT do

- No mocks anywhere under `test-e2e/` — the entire point is the real daemon.
- No `:latest` tags for images you choose (MinIO exception documented above).
- No parallel test execution.
- No editing of `deploy.yml` or any protected file.
- No cleanup that touches resources lacking the e2e label/prefix (except the
  MinIO container the suite itself created, per the preExisting record).
- Do not skip the negative tests (bad image, broken lambda, malformed
  proxy response, 404s) — negative paths are where regressions hide.

## Acceptance criteria

1. `npm run test:e2e` passes locally against a real daemon and leaves the
   daemon in its pre-run state (verify: `docker ps -a` before/after diff is
   empty apart from pre-existing resources).
2. All six files and every numbered scenario above are implemented; each
   scenario is a named subtest whose name matches its description here
   closely enough to map by eye.
3. `.github/workflows/e2e.yml` exists, parses, and the suite passes in CI
   in under 20 minutes (evidence: link the green run in the PR).
4. `npm test` (unit) is unaffected and still daemon-free.
5. `npm run typecheck` and `npm run lint` pass.

## Verification

```bash
npm run typecheck && npm test && npm run lint
docker ps -aq | sort > /tmp/before.txt
npm run test:e2e
docker ps -aq | sort > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt && echo "CLEANUP OK"
```

Paste the `CLEANUP OK` evidence and the suite's timing summary into the PR
description.

## Commit and push

Commit per step (`test(gap-07): ...`), then
`git push -u origin gap/07-e2e-tests`; PR title
`test: e2e integration suite against a real Docker daemon`.
