# Prompt: Security hardening + Caddy / console-availability reliability

**Repo:** `miltonejones/docker-iaas` · **Base branch:** `main` · **Deliverable:** code changes
across two workstreams, each item with a concrete change, a test, and a green CI gate.

## How to use this prompt

This is derived from a whole-app review. It has two workstreams — **A: Security hardening**
and **B: Caddy / console-availability reliability** — plus a cross-cutting item to make the
test gate real. Ground every change in the current code (file references are given and were
accurate at the time of writing; re-verify before editing). Work the items in the
**Sequencing** order. This is a **single-operator** deployment today: harden accordingly, but
don't assume a multi-tenant model exists — favour allowlists and fail-closed defaults over a
full RBAC build-out.

A recurring lesson from recent incidents: **`tsc` passing is not safety.** Every outage in this
area (a dropped base Caddy block; a Docker-exec stream-framing bug corrupting the TLS domain)
type-checked cleanly and only failed at runtime. Prefer integration tests that exercise the
real failure mode.

---

## Workstream A — Security hardening

### A1. Close the `/api/github` auth hole  (P0)
`server/src/index.ts` mounts `app.use('/api/github', githubRouter)` **without** `requireAuth`,
and `server/src/routes/github.ts` adds none internally. So `POST /api/github/commit-and-push`,
`/pull-to-bucket`, and `/pull-to-container` are reachable **unauthenticated** and act using the
server's GitHub token (mounted secret). Caddy fronts this publicly.
- **Fix:** add `requireAuth` at the mount (mirror the other `/api/*` routers).
- **Test:** an unauthenticated request to each github route returns 401.

### A2. Audit auth coverage on every route  (P0)
Enumerate every `app.use('/api/...')` in `index.ts` and every per-route public exception.
Confirm the intended public set and require auth on everything else. Intended public today:
`/api/auth`, `/api/system/ping`, `/api/system/presets`, the `/gw` data plane, and the
`/api/notifications` POST (pre-shared key). Everything else must require a token.
- **Test:** a table-driven test that hits each router unauthenticated and asserts 401, with an
  explicit allowlist for the intended-public set (so a future unauthenticated router fails CI).

### A3. Strip sensitive headers on all gateway proxy paths  (P1)
`server/src/gatewayHandlers.ts` defines `stripSensitiveHeaders` but currently applies it **only
on the WebSocket path**. The normal container path uses
`createProxyMiddleware({ target, changeOrigin: true })`, which forwards the original request
headers — including `Authorization` and `Cookie` — to the backend container. A tenant's app
should not receive the caller's console credentials.
- **Fix:** apply `stripSensitiveHeaders` on the non-WS proxy path too (http-proxy-middleware
  `onProxyReq`/header rewrite), and confirm bucket/lambda handlers don't echo them either.
- **Test:** a request carrying `Authorization`/`Cookie` reaches the backend with those removed.

### A4. Allowlist the high-risk assistant/consumer tools  (P1)
The assistant exposes ~60 tools (`server/src/routes/assistant.ts`); several are host- or
account-level. Add env-configured allowlists and fail closed outside them:
- `read_host_file` / `list_host_directory` → path allowlist; reject traversal / paths outside it.
- `manage_dns_records` and Route 53 ops → hosted-zone / DNS-suffix allowlist; refuse names
  outside it (this is account-wide Route 53 CRUD today).
- `run_host_build_preset` / `execute_container_command` → bound and document; prefer a preset /
  command allowlist.
- GitHub push tools → repo allowlist.
- **Test:** each guarded tool rejects an out-of-allowlist target.

### A5. Reduce the host-mount blast radius  (P1/P2)
`docker-compose.yml` mounts `/:/host:ro` — the **entire host filesystem**, readable — which
`read_host_file` and the LLM can traverse. Scope it to the specific path(s) disk-usage
reporting actually needs (the mount point(s) it runs `statfs` against), not `/`. Separately,
document that the `/var/run/docker.sock` mount is the core trust boundary (root-equivalent), and
consider fronting it with a scoped docker-socket proxy that only exposes the endpoints Dockyard
uses. (See open question on which host paths are actually required.)

### A6. Constrain the autonomous consumer  (P1)
The `consumer` service runs an LLM that auto-fixes issues and **pushes to GitHub** (mounts
`./.git` rw), driven by untrusted issue text — a prompt-injection vector. Enforce:
push only to `consumer/*` branches (never `main`), PR-gated, with a scoped token; bound/sanitise
issue text; add a denylist for destructive operations; and record every push via `recordAuditLog`.
- **Test:** the consumer's push path refuses a non-`consumer/*` target.

### A7. Baseline abuse controls  (P2)
Rate-limit the login endpoint and the public `/gw` plane. Confirm `recordAuditLog` covers all
high-risk mutations (containers, host files/builds, DB ops, GitHub, DNS); keep the
`GET /api/system/audit` read endpoint `requireAuth`-gated.

---

## Workstream B — Caddy / console-availability reliability

**Why:** Caddy fronts the whole console, so a bad reload can take the console itself offline —
which happened twice. `main` already fixed the acute bugs: `getBaseConfig()` now reads the base
from the **immutable, volume-mounted** `/etc/caddy/Caddyfile` via `fs` (not `docker exec`), and
`reloadCaddy()` refuses to push when the base is empty or when the merged config doesn't contain
`dockyard-ai.com`. This workstream is the remaining **defense-in-depth so the class can't recur.**

### B1. Validate config before applying  (P1)
Before `caddy reload`, run `caddy validate --config <file>` (or `caddy adapt`) inside the
container; on failure, log and abort, leaving the previous running config untouched. (`caddy
reload` already refuses invalid config, but an explicit validate gives a clear, testable failure
signal and catches adapt-time errors.)

### B2. Kill the latent exec-framing bug for good  (P1)
`execInCaddy` (`server/src/caddy.ts`) still accumulates `chunk.toString()` **without
demultiplexing** the Docker exec stream — the exact bug that prefixed the base domain with
`01 00 00 00 00 00 00 31` and produced an invalid TLS identifier. It's currently only used for
`caddy reload` (output unparsed), so it's dormant — but any future reuse to read content
re-introduces corruption.
- **Fix:** demux via `container.modem.demuxStream(stream, stdoutBuf, stderrBuf)` (or run with
  `Tty: true`), so `execInCaddy` returns clean output. At minimum, add a loud comment forbidding
  its use for reading content — but prefer the real demux.

### B3. Never let a custom-domain block break the base site  (P1)
Keep the base `dockyard-ai.com` site authoritative and untouchable; only ever add/remove
custom-domain site blocks. Prefer having Caddy `import` a sites file/dir it owns over the console
pushing a merged monolithic `/data/Caddyfile`. Keep the existing "refuse to push without base /
missing base domain" guards. Ensure one domain's failing ACME can't wedge others (separate site
blocks already isolate certs — verify, and avoid any global cert setting that couples them).

### B4. Guarantee a break-glass path to the console  (P1)
The console is published only on `127.0.0.1:4300`. If Caddy is broken, the operator can only
reach it locally. Make console reachability **independent of custom-domain reloads**: document
the SSH-tunnel/localhost recovery path, and/or add a second minimal always-valid ingress (a
fixed admin hostname whose site block is never regenerated). (See open question on remote access.)

### B5. Surface reload health  (P2)
Reload failures are currently logged and swallowed. Record reload success/failure (audit + a
status the UI can read) so a failed reload is visible rather than silent, and expose enough to
alert on repeated failures.

### B6. Test the reload path  (P1)
Integration-test `reloadCaddy` with a mocked Docker client: it builds base + sites, refuses on
empty/missing base, and never emits a config lacking `dockyard-ai.com`. Add a smoke test
(extend `scripts/smoke-test-hardening.sh`): enabling a bogus/unresolvable domain must never
remove or break the base site or the console's own reachability.

---

## Cross-cutting — make the test gate real  (P0)

The suite does not currently pass clean (a failing `auth.test` is acknowledged), so the CI
`verify` job (`npm test`) is either red or tolerating a failure. Fix or quarantine the failing
test so `verify` is genuinely green, and ensure CI **hard-fails** on `npm test`. Then add the
integration coverage called for above (auth-on-every-router, gateway header stripping, Caddy
reload). Reminder: every incident in this domain passed `tsc` — type-checking is not the gate.

---

## Sequencing

1. **P0:** A1 (`/api/github` auth), A2 (auth-coverage audit + test), and the green test gate.
2. **P1 reliability & isolation:** B1 (validate), B2 (exec demux), B3 (base-site isolation),
   B4 (break-glass), A3 (header stripping), A4 (tool allowlists), A6 (consumer constraints),
   B6 (reload tests).
3. **P2:** A5 (host-mount scoping), A7 (rate limits, audit coverage), B5 (reload health).

## Acceptance criteria

- Every `/api/*` router requires auth except the documented public set — proven by a test that
  fails if a new unauthenticated router appears.
- No `Authorization`/`Cookie` header is forwarded to a gateway backend on any path (WS or HTTP).
- Enabling an unresolvable/bogus custom domain cannot take the console offline (smoke test).
- `caddy validate` gates every reload; `execInCaddy` demultiplexes its output.
- High-risk tools enforce allowlists (host paths, DNS zones/suffixes, repos).
- `npm test` is green and CI hard-fails on it.

## Open questions (resolve with the maintainer)

1. **Remote access model:** is the console ever reached directly (non-localhost), or always
   behind Caddy at `dockyard-ai.com`? This determines the B4 break-glass design.
2. **Single-operator vs. multi-user:** is a second user ever planned? Determines how far to push
   per-user scoping vs. relying on allowlists + "trusted operator" assumptions.
3. **Host paths needed:** exactly which host path(s) does disk-usage reporting read? Determines
   how tightly A5 can scope the `/host` mount.

## Out of scope / follow-ups

- A full multi-tenant authorization/RBAC model.
- Replacing the Docker socket mount with a fully brokered API.
- SSO/OAuth for console login.
