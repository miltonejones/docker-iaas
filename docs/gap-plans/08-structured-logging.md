# Prompt 08 — Structured JSON logging with request and issue correlation

You are an LLM coding agent working in `miltonejones/docker-iaas` (project
**Dockyard**). The server logs via bare `console.log`/`console.error` with
no timestamps, levels, or request correlation. Dockyard runs an autonomous
issue→fix pipeline; when that pipeline misbehaves, diagnosing it requires
tracing a request (or an issue id like `iss-1785460607119-ngbt8t`) across
server logs, consumer activity, and deploy notifications — impossible with
unstructured prints. Your task: minimal structured logging, done without
frameworks.

## Global rules you must obey

- Branch: `gap/08-structured-logging` from latest `origin/main`. Never push
  to `main`. Never force-push.
- Protected files — do NOT touch: `Dockerfile.consumer`, `docker-compose.yml`,
  `docker-compose.ci.yml`, `Caddyfile`, `.gitignore`,
  `.github/workflows/deploy.yml`, `scripts/issue-consumer.mjs`,
  `scripts/protected-files.json`, `scripts/smoke-test-hardening.sh`.
  NOTE: `scripts/issue-consumer.mjs` is protected — consumer-side log
  correlation is therefore OUT of scope; you only make the server side
  correlation-ready (Step 4).
- **Zero new dependencies.** No pino, no winston, no morgan. Node's
  `console` writing one JSON object per line is sufficient for a
  single-node app whose logs are read via `docker logs`. (Reason to state
  in the PR: dependency count is a supply-chain concern in a repo an AI
  edits autonomously.)
- Do not remove the `playwright` dependency.

## Read first

1. `server/src/index.ts` — startup banner logs (these stay human-readable;
   see Step 5).
2. `grep -rn "console\.\(log\|error\|warn\)" server/src --include='*.ts' | grep -v test | wc -l`
   and skim the hits — know the scale before you start.
3. `server/src/db/audit.ts` — the audit trail (do not conflate: audit events
   are product data, logs are diagnostics; you are changing logs only).
4. How errors currently surface: `server/src/services/HttpError.ts` and a
   sample route's catch blocks.

## Design (implement exactly this, nothing fancier)

One module, `server/src/log.ts`:

```ts
type Level = 'debug' | 'info' | 'warn' | 'error';
interface LogFields { [k: string]: unknown }

log.debug(msg: string, fields?: LogFields): void
log.info(...)  log.warn(...)  log.error(...)
log.child(bound: LogFields): Logger        // returns a logger with fields pre-bound
```

- Output: ONE line of JSON to stdout (debug/info) or stderr (warn/error):
  `{"ts":"2026-08-01T12:00:00.000Z","level":"info","msg":"...","reqId":"...", ...fields}`.
- `LOG_LEVEL` env (default `info`) filters; `debug` is compiled in but off
  by default.
- `LOG_FORMAT=pretty` env value switches to a human `HH:MM:SS LEVEL msg
  {fields}` rendering for local dev; the `scripts/dev.mjs` launcher should
  set `LOG_FORMAT=pretty` by default (edit `scripts/dev.mjs` — it is NOT on
  the protected list; verify against `scripts/protected-files.json` before
  editing anyway).
- Serialization safety, pedantically: fields go through a `safeStringify`
  with (a) circular-reference protection (util.inspect fallback or a
  WeakSet replacer), (b) `Error` instances expanded to
  `{ name, message, stack }`, (c) values longer than 2 000 chars truncated
  with `…[truncated]`, (d) keys named `password`, `token`, `secret`,
  `authorization`, `apiKey`, `api_key` (case-insensitive, at any depth)
  redacted to `"[redacted]"`. Write unit tests for all four behaviors
  BEFORE wiring the logger anywhere (test-first here; the redaction rule is
  the one that matters most in a codebase that handles DB credentials).

## Step-by-step instructions

### Step 1 — `log.ts` + tests

Implement the module above and `server/src/log.test.ts` covering: level
filtering, child-field merging (child fields win over call fields? NO —
call-site fields win over bound fields; test it), circular refs, Error
expansion, truncation, redaction (nested, mixed case), stdout/stderr
routing (capture via monkey-patching `process.stdout.write` in the test).

### Step 2 — Request correlation middleware

In `server/src/index.ts` `createApp()`, immediately after `cors()`:

1. Generate `req.id`: use the incoming `X-Request-Id` header if it matches
   `/^[A-Za-z0-9_-]{8,64}$/` (Caddy or curl callers may supply one),
   otherwise `crypto.randomUUID()`. Declare the Express `Request`
   augmentation next to the existing one in `server/src/auth.ts` (follow
   that file's `declare global` idiom, but put yours in a shared
   `server/src/types-augment.d.ts` if one doesn't exist — one file, not
   scattered).
2. Set `res.setHeader('X-Request-Id', req.id)` on every response.
3. Attach `req.log = log.child({ reqId: req.id })`.
4. Access log on `res.on('finish')`: level `info`, msg `request`, fields
   `{ method, path: req.path, status, durationMs, userId: req.authUser?.userId ?? null, bytes: res.getHeader('content-length') ?? null }`.
   Exclusions, exactly: paths ending `/stream` (SSE — one open request is
   not one event; log SSE connect/disconnect instead at debug), `/gw/`
   prefixed and custom-domain gateway traffic (already covered by the
   gateway telemetry table — logging them twice doubles noise; put this
   reasoning in a comment), and `/api/system/health` if it exists (health
   probes every few seconds would drown everything).
5. NEVER log: query strings (may carry `?token=` — the codebase explicitly
   allows JWTs in query params for SSE!), request bodies, or header values.
   Log header *names* never, values never. Path only, not originalUrl with
   query. Add a test asserting a request to `/api/x?token=abc` produces a
   log line that does not contain `abc`.

### Step 3 — Migrate existing call sites

1. Mechanically convert every `console.log/warn/error` under `server/src/`
   (excluding tests and the Step 5 banner) to the logger with a sensible
   msg and fields. Rules:
   - error catches: `log.error('<what failed>', { err })` — pass the Error
     object itself; the serializer expands it.
   - polling/loop noise (anything that would fire every few seconds) goes
     to `debug`, not `info`. Find these by reading each call site, not by
     pattern matching.
   - inside request handlers use `req.log`, not the global, so reqId flows.
2. This is a wide but shallow diff. Keep it mechanical: one commit for the
   logger, one for the middleware, ONE for the sweep — reviewers diff the
   sweep commit with `--stat` and spot-check.

### Step 4 — Issue-pipeline correlation (server side only)

1. Wherever the server handles issue lifecycle (search `iss-` and
   `issues` under `server/src/routes/assistant.ts` and
   `server/src/db/assistantIssues.ts`): every log line in those paths must
   include `issueId` in fields when one is in scope. Use
   `req.log.child({ issueId })` at the top of each such handler.
2. The notifications POST endpoint (`server/src/routes/notifications.ts`)
   receives consumer events: if the body contains an issue id (inspect the
   real shape — read the code and one line of
   `scripts/issue-logs/notifications.jsonl` for the field name), log the
   receipt at info with `{ issueId, summary }` (summary passes through the
   redactor like everything else).
3. Out of scope (protected file): making the consumer SEND an
   `X-Request-Id`. Note in the PR description: "Follow-up requiring
   human-approved consumer change: propagate issue id as X-Request-Id from
   consumer → server so both sides share one correlation key."

### Step 5 — Keep the startup banner human

The multi-line startup banner in `server/src/index.ts` (listen callback:
"Dockyard.ai server listening…", daemon reachability, MinIO status) stays
`console.log` human-readable ON PURPOSE — it is the first thing a human
sees in `docker logs`. Add a comment saying so. Everything after boot goes
through the structured logger.

### Step 6 — Docs

README Configuration table: add `LOG_LEVEL` (default `info`) and
`LOG_FORMAT` (`json` default, `pretty` for dev). One paragraph under a new
"Logs" heading: one-JSON-object-per-line on stdout/stderr, `docker logs
dockyard | jq 'select(.reqId=="…")'` as the worked example, and the
redaction guarantee.

## Things you must NOT do

- No logging library dependencies.
- No log files on disk, no rotation — stdout/stderr only (Docker owns
  retention).
- No logging of query strings, bodies, or header values, anywhere, ever.
- Do not convert the web (`web/`) or relay in this prompt; server only.
  (Relay is small and can be a follow-up; say so in the PR.)
- Do not rename, rewrap, or "improve" the audit-event system.
- Do not touch `scripts/issue-consumer.mjs`.

## Acceptance criteria

1. All non-banner server logs are single-line JSON with ts/level/msg, and
   request-scoped ones carry `reqId` (+ `userId` when authenticated,
   `issueId` in issue paths).
2. Every response carries `X-Request-Id`; incoming valid ids are honored.
3. Redaction/truncation/circular/Error handling all proven by unit tests;
   the `?token=` non-leak test exists.
4. SSE, `/gw`, and health paths are excluded from access logs with the
   reasoning commented.
5. `grep -rn "console\." server/src --include='*.ts' | grep -v test | grep -v log.ts` returns only the startup banner lines.
6. `npm run typecheck`, `npm test`, `npm run lint` pass.

## Verification

```bash
npm run typecheck && npm test && npm run lint
grep -rn "console\." server/src --include='*.ts' | grep -v ".test.ts" | grep -v "log.ts"
# start dev server; curl any endpoint; confirm one JSON access line with reqId,
# and that the same value came back in the X-Request-Id response header.
```

Paste a sample log line (redacted as needed) into the PR description.

## Commit and push

Commits per step (`feat(gap-08): ...`; the sweep commit is
`refactor(gap-08): migrate console.* to structured logger`), then
`git push -u origin gap/08-structured-logging`; PR title
`feat: structured JSON logging with request/issue correlation`.
