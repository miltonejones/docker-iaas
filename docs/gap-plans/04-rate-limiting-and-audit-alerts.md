# Prompt 04 — Rate limiting, login throttling, and audit alerting

You are an LLM coding agent working in `miltonejones/docker-iaas` (project
**Dockyard**). Dockyard's API fronts a Docker daemon (root-equivalent on the
host) with password login and **no rate limiting anywhere** — no brute-force
protection on `/api/auth`, no request throttling, and an audit log that
nothing watches. Your task closes all three.

## Global rules you must obey

- Branch: `gap/04-rate-limiting` from latest `origin/main`. Never push to
  `main`. Never force-push.
- Protected files — do NOT touch: `Dockerfile.consumer`, `docker-compose.yml`,
  `docker-compose.ci.yml`, `Caddyfile`, `.gitignore`,
  `.github/workflows/deploy.yml`, `scripts/issue-consumer.mjs`,
  `scripts/protected-files.json`, `scripts/smoke-test-hardening.sh`.
- Do not remove the `playwright` dependency.
- One new dependency is authorized: `express-rate-limit` (server workspace
  only). Nothing else. No Redis, no external stores — this is a single-node
  app; in-memory stores are correct here.

## Read first

1. `server/src/index.ts` — middleware order. Rate limiting placement in this
   order is the crux of this task; study where `cors()`, the custom-domain
   gateway middleware, `/gw`, the unauthenticated bucket GET, the body
   parsers, and the routers mount.
2. `server/src/routes/auth.ts` — login / register / consumer-key exchange.
3. `server/src/db/audit.ts` and `server/src/routes/system.ts` (`GET
   /api/system/audit`) — the existing audit log you will alert from.
4. `server/src/routes/notifications.ts` and the SSE notification stream —
   alerts will be delivered as notifications (reuse this pipeline; do NOT
   build a new one).
5. `server/src/auth.ts` — note that `requireAuth` accepts `?token=` query
   tokens (SSE clients); your limiter keying must not break SSE.

## Design you will implement (do not improvise)

Three limiter tiers plus one detector:

| Name | Scope | Key | Limit | Window | On limit |
|------|-------|-----|-------|--------|----------|
| `authLimiter` | `POST /api/auth/login` (and register if present) | IP | 10 | 15 min | 429 + audit event |
| `authFailLimiter` | failed logins only | IP **and** submitted email, independently | 5 fails | 15 min | 429 + audit event `auth.lockout` |
| `apiLimiter` | all `/api/*` EXCEPT SSE stream endpoints and `GET /api/system/usage` | authenticated userId, else IP | 600 | 1 min | 429 |
| lockout detector | audit stream | — | 3 lockouts / hour | 1 h | notification `security` |

Pedantic details:

- **Trust proxy.** The app sits behind Caddy (and compose publishes
  `127.0.0.1:4300`). Without `app.set('trust proxy', ...)`, every request's
  IP is Caddy's and one attacker rate-limits everyone. Set
  `app.set('trust proxy', 1)` in `createApp()` (exactly one hop — Caddy).
  Add a comment explaining exactly this. Do NOT use `true` (that trusts
  arbitrary spoofed `X-Forwarded-For` chains).
- **SSE exemption is mandatory.** The endpoints `/api/system/usage/stream`,
  `/api/notifications/stream` (and `/api/system/stats/stream` if it exists by
  the time you run) hold one long request each — but reconnect loops on
  flaky networks can burn requests fast, and conversely a limiter that
  counts each frame does not exist (frames aren't requests) — the real risk
  is a low bucket blocking reconnects. Exempt paths ending in `/stream`
  from `apiLimiter` via its `skip` option, with a comment.
- **`/gw/*` and custom-domain traffic are NOT limited in this prompt.**
  Gateway routes are user-facing apps with their own traffic patterns;
  throttling them needs product thought. State this as a non-goal in the PR.
- **The consumer must not be throttled into failure.** The issue consumer
  calls the API in a loop from inside the compose network. 600/min per
  identity is far above its needs, but to be safe: requests presenting a
  valid consumer JWT (or `x-consumer-api-key`) are keyed by that identity,
  not by IP, so they cannot collide with a user's bucket.

## Step-by-step instructions

### Step 1 — Dependency and shared module

1. `npm --workspace server install express-rate-limit`.
2. Create `server/src/rateLimit.ts` exporting the three configured limiters.
   Use `express-rate-limit` with defaults `standardHeaders: true`,
   `legacyHeaders: false`, and a JSON handler producing
   `{ error: 'Too many requests. Try again in <n> seconds.' }` with the
   actual reset time. All windows/limits read from env with the table's
   defaults: `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_AUTH_WINDOW_MS`,
   `RATE_LIMIT_API_MAX`, `RATE_LIMIT_API_WINDOW_MS`,
   `RATE_LIMIT_FAILS_MAX` — parse once at module load, document each in the
   README's configuration table (README.md edit is allowed — it is not
   protected).
3. `apiLimiter` `keyGenerator`: if `req.authUser?.userId` exists use
   `user:<id>`; else if a valid consumer key header is present use
   `consumer`; else `ip:<req.ip>`. NOTE the ordering problem: `apiLimiter`
   runs BEFORE `requireAuth` populates `req.authUser` if you mount it
   globally. Solve it the simple way: mount `apiLimiter` per-router AFTER
   `requireAuth` in each `app.use('/api/x', requireAuth, apiLimiter, router)`
   chain, and mount an IP-keyed instance on the few unauthenticated `/api`
   surfaces (`/api/auth`, `/api/notifications`, the bucket-object GET).
   Do not try to be clever with deferred key resolution.

### Step 2 — Login throttling and failure lockout

1. Mount `authLimiter` on the auth router's credential endpoints only — not
   on `GET` token-introspection-style routes if any exist.
2. Implement `authFailLimiter` inside `server/src/routes/auth.ts` login
   handler logic, NOT as generic middleware, because it must count only
   *failures* and must key on both IP and the submitted email:
   - keep an in-memory `Map<string, { count, resetAt }>` (module scope) for
     keys `ip:<ip>` and `email:<lowercased email>`; increment both on a
     failed password check; clear both on success.
   - when either counter reaches 5 within 15 minutes: respond 429 (NOT 401 —
     429 tells the client it is locked, and does not leak whether the
     password was right), write an audit event of type `auth.lockout` with
     the IP and email via the existing audit helper in
     `server/src/db/audit.ts` (match its call signature exactly), and keep
     the lockout for the remainder of the window.
   - IMPORTANT anti-enumeration rule: the lockout response must be identical
     whether or not the email exists in the users table.
3. On every failed login (even below threshold) write audit event
   `auth.login_failed`. On success write `auth.login_ok`. Check first —
   if the auth routes already write audit events, extend rather than
   duplicate.

### Step 3 — Audit alerting

1. Create `server/src/services/securityAlerts.ts`:
   - a module-level check run whenever an `auth.lockout` audit event is
     written (call it directly from the code path that writes the event —
     do not poll the DB): count `auth.lockout` events in the last hour
     (query the audit table); if ≥ 3 and no `security.alert` notification
     was emitted in the last hour (dedupe guard — query or remember in
     module state), emit a notification through the same mechanism the rest
     of the server uses (find how server-side events append to the
     notifications pipeline — `server/src/services/notifications.ts` — and
     call it) with level `error`, summary
     `🚨 Repeated login lockouts — possible brute-force attempt`, body
     listing the distinct IPs and emails involved.
2. This surfaces in the existing UI notification bell and desktop
   notifications automatically — verify by reading the notification flow;
   do not build UI.

### Step 4 — Tests

All in server workspace, supertest against `createApp()` where applicable:

1. `server/src/rateLimit.test.ts`:
   - 11th login attempt from one IP inside the window → 429.
   - 5 failed logins for one email from rotating IPs → 429 on the 6th even
     from a fresh IP (email-key proof).
   - successful login resets the email counter.
   - lockout response body identical for existing vs non-existing email.
   - `apiLimiter` skips `/stream` paths (assert via its `skip` fn directly).
2. Alerting: unit-test the threshold/dedupe logic with a faked audit-count
   function (export it with injectable deps for testability).
3. Determinism: never `sleep` real window durations in tests — construct the
   limiters with tiny windows via the env vars (set them in the test before
   importing, or export a factory taking options; prefer the factory).

## Things you must NOT do

- No Redis/memcached/external anything.
- No CAPTCHA, no account-email sending — out of scope.
- Do not rate-limit `/gw/*` or custom-domain gateway traffic.
- Do not change `webhookAuth` or the GitHub webhook path's behavior beyond
  the generic apiLimiter.
- Do not set `trust proxy` to `true`.
- Do not lower the consumer's effective throughput (see design table notes).

## Acceptance criteria

1. Brute-forcing login is capped by IP and by target email; lockout is
   opaque to account existence; every failure and lockout is audited.
2. General API abuse is capped per-identity at 600/min with SSE exempt.
3. ≥3 lockouts/hour produces exactly one security notification per hour in
   the bell/desktop pipeline.
4. `trust proxy` is 1, with the explanatory comment.
5. README configuration table documents the five new env vars.
6. `npm run typecheck`, `npm test`, `npm run lint` pass.

## Verification

```bash
npm run typecheck && npm test && npm run lint
# Manual, with dev server:
for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST localhost:4300/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"nobody@example.com","password":"wrong"}'; done
# expect 401s turning into 429s
```

Paste the status-code sequence into the PR description.

## Commit and push

Commits per step (`feat(gap-04): ...`), then
`git push -u origin gap/04-rate-limiting`; PR title
`feat: rate limiting, login lockout, and brute-force alerting`.
