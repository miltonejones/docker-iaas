# Prompt 01 — Role-based access control (admin / operator / viewer)

You are an LLM coding agent working in `miltonejones/docker-iaas` (project
**Dockyard**, a personal Docker container management console). Your task is to
introduce **roles** so that not every logged-in user has full control of the
Docker daemon, saved database credentials, and host files. Today, auth is
binary: any valid JWT can do anything. That is the gap.

## Global rules you must obey

- Branch: `gap/01-rbac`, created from latest `origin/main`. Never push to
  `main`. Never force-push.
- Protected files you must NOT touch in this prompt: `Dockerfile.consumer`,
  `docker-compose.yml`, `docker-compose.ci.yml`, `Caddyfile`, `.gitignore`,
  `.github/workflows/deploy.yml`, `scripts/issue-consumer.mjs`,
  `scripts/protected-files.json`, `scripts/smoke-test-hardening.sh`.
- Do not remove the `playwright` dependency.
- Run the verification commands after each step; never build on a failure.
- **Backwards compatibility is a hard requirement**: existing users and
  existing JWTs must keep working after deploy (details in Step 2).

## Architecture context you need first

Read these files fully before writing any code:

- `server/src/auth.ts` — JWT signing/verification, `requireAuth`,
  `optionalAuth`, `webhookAuth` middleware. `requireAuth` sets
  `req.authUser = { userId, email }`.
- `server/src/db.ts` — SQLite schema and helpers, including the `users` table
  and `getUserById`.
- `server/src/routes/auth.ts` — login/register/consumer-token endpoints.
- `server/src/index.ts` — route mounting; every `/api/*` router is mounted
  with `requireAuth` except `/api/system` (per-route auth), `/api/auth`,
  `/api/notifications` (optionalAuth), `/api/github` (webhookAuth), and the
  unauthenticated bucket-object GET.
- `server/src/routes/authCoverage.test.ts` — an existing test that asserts
  route auth coverage. You will extend this pattern.

## The role model you will implement

Exactly three roles, stored as a string column:

| Role | Intent | May do |
|------|--------|--------|
| `admin` | Owner | Everything, including user management, settings, webhook-secret rotation, DB credential CRUD, host files/builds, prune |
| `operator` | Day-to-day use | Container lifecycle (start/stop/restart/launch/remove), logs, images, buckets (read/write objects), lambda create/run, gateway route CRUD, DB read queries and previews |
| `viewer` | Read-only | GET endpoints only: lists, logs, usage streams, notifications, gateway traffic telemetry |

Pedantic clarifications, so you do not have to guess:

- `operator` may NOT: create/update/delete saved database connections,
  execute confirmed DB mutations/migrations/grants/restores, use
  `/api/host-files/*` or `/api/host-builds/*`, rotate the webhook secret,
  prune build cache/images, or manage users. Those are `admin` only.
- `operator` MAY run DB **read** queries (`POST .../read`) and request
  **previews** (the `confirmed: false` flow) — but any request body
  containing `confirmed: true` on grant/mutate/migrate/backup/restore
  endpoints requires `admin`.
- `viewer` may NOT call `POST /api/buckets/:name/objects/*` (upload) or any
  other non-GET verb, with one exception: `POST` SSE-adjacent endpoints do
  not exist here, so the rule is simply "viewer ⇒ GET only".
- The **consumer JWT** (issued via the consumer API key exchange in
  `server/src/routes/auth.ts`) must map to a dedicated role `admin` — it
  needs to PATCH issues and read settings. Verify what user record that token
  is issued for and make sure that record gets `admin`.

## Step-by-step instructions

### Step 1 — Schema migration

1. In `server/src/db.ts`, find where the `users` table is created and where
   schema migrations/`ALTER TABLE` statements run (search for
   `CREATE TABLE` and follow the established migration pattern in `initDb`).
2. Add a `role TEXT NOT NULL DEFAULT 'admin'` column via the same pattern the
   file already uses for adding columns (better-sqlite3, so
   `ALTER TABLE users ADD COLUMN ...` guarded by a check of
   `PRAGMA table_info(users)` — copy the existing idiom exactly; do not
   invent a new migration framework).
3. Default is `'admin'` deliberately: every pre-existing user keeps full
   access after deploy. Do not default to `viewer` — that would lock the
   owner out.
4. Update `getUserById` (and any `getUserByEmail`-style helper) to return the
   `role` field. Update the exported user TypeScript types.

### Step 2 — Token and middleware changes (backwards compatible)

1. In `server/src/auth.ts`:
   - Extend `AuthUser` to `{ userId, email, role }`.
   - `signToken` must include `role` in the JWT payload.
   - `requireAuth` must populate `req.authUser.role`. **Critical:** old JWTs
     (issued before this change) have no `role` claim and remain valid for up
     to 7 days. Therefore `requireAuth` must NOT trust the token's role claim
     at all — it already loads the user row via `getUserById(payload.userId)`;
     take the role from the **database row**, not the token. This makes old
     tokens work and makes role changes take effect immediately without
     re-login. Keep the role in the token anyway (it is useful for the client
     UI), but the server-side authority is the DB row.
2. Add a new middleware factory in `server/src/auth.ts`:
   ```ts
   export function requireRole(...allowed: Array<'admin' | 'operator' | 'viewer'>) {
     return (req: Request, res: Response, next: NextFunction) => { ... };
   }
   ```
   It assumes `requireAuth` already ran (if `req.authUser` is absent, return
   500 with a message saying requireRole was mounted without requireAuth —
   that is a programmer error worth failing loudly on). If the user's role is
   not in `allowed`, respond `403 { error: 'Requires role: <list>.' }`.
   `admin` is implicitly allowed everywhere: add it to the allowed set inside
   the factory so call sites never accidentally exclude it.
3. Add a convenience `requireWrite` = `requireRole('operator')` (which per
   rule 2 also admits admin) and use plain `requireAuth` for viewer-safe GETs.

### Step 3 — Apply per-router and per-route

Do the mounting in `server/src/index.ts` and inside individual routers.
Follow this table exactly:

| Mount | Policy |
|-------|--------|
| `/api/containers` | GET routes: any authenticated. POST/DELETE lifecycle: `operator`+ |
| `/api/images` | GET: any. `POST /prune`: `admin` |
| `/api/system` | GET routes: any. `POST /build-cache/prune`, `POST /webhook-secret/rotate`, `GET /webhook-secret`: `admin` |
| `/api/lambda` | GET: any. create/update/delete/run: `operator`+ |
| `/api/gateway` | GET (incl. traffic telemetry): any. route CRUD: `operator`+ |
| `/api/volumes` | GET: any. mutating: `admin` |
| `/api/buckets` | GET/list: any. upload/delete: `operator`+ |
| `/api/host-files` | ALL routes: `admin` |
| `/api/host-builds` | ALL routes: `admin` |
| `/api/databases` | overview/connections GET/schema/read/jobs GET: `operator`+ (viewer gets nothing here — DB metadata is sensitive). Connection CRUD, and ANY request whose body has `confirmed === true`: `admin` |
| `/api/projects` | GET: any. mutating: `operator`+ |
| `/api/assistants`, `/api/assistant` | `operator`+ (the assistant can invoke tools) |
| `/api/notifications` | unchanged (optionalAuth) |
| `/api/auth` | unchanged, except new user-management endpoints below |

Implementation notes, pedantically:

- Where a router mixes GET and mutating verbs, apply `requireRole` on the
  individual route definitions inside `server/src/routes/<name>.ts`, not on
  the mount — mounting a blanket role check would break viewer GETs.
- For the `confirmed: true` escalation on `/api/databases`, write ONE small
  middleware `requireAdminIfConfirmed` in the databases router: if
  `req.body?.confirmed === true` and role is not admin, 403 with
  `error: 'Executing confirmed database operations requires the admin role.'`.
  Mount it on the grant/mutate/migrate/backup/restore routes after the body
  parser. Do not duplicate the check in service code.
- Do not change `webhookAuth` semantics; webhook-authenticated requests are
  not user requests and bypass roles (they already only reach
  `/api/github`).

### Step 4 — User management endpoints (admin only)

In `server/src/routes/auth.ts` add:

- `GET /api/auth/users` — list users `{ id, email, role, createdAt }`
  (NEVER return password hashes). `admin` only.
- `PATCH /api/auth/users/:id` — body `{ role }`, validated against the three
  literal strings. `admin` only. Refuse (400, message
  `'You cannot demote the last remaining admin.'`) any change that would
  leave zero admins — count admins in the same transaction.
- `DELETE /api/auth/users/:id` — `admin` only, same last-admin guard, and a
  user may not delete themselves (400).

If a registration endpoint exists and is open, make new registrations default
to role `viewer` EXCEPT the first user ever created, who becomes `admin`
(check `SELECT COUNT(*) FROM users` inside the same transaction).

### Step 5 — Web UI

Read `web/src/AuthContext.tsx` and `web/src/api.ts` first.

1. Decode the role from the login response / JWT payload into the auth
   context (add `role` to the stored user object; parse the JWT payload with
   `JSON.parse(atob(token.split('.')[1]))` only as a fallback if the login
   response lacks it — prefer returning `role` explicitly from the login
   endpoint).
2. Gate UI affordances, do not merely hide errors:
   - viewer: hide start/stop/restart/remove buttons, launch gallery's Launch
     button, upload/delete in buckets, all of Databases page's mutating
     forms, Settings mutation controls.
   - operator: hide Host files / Host builds UI, DB connection create/edit,
     prune buttons, webhook-secret rotation, user management.
   - admin: sees a new **Users** section in `web/src/pages/Settings.tsx`
     listing users with a role dropdown (PATCH) and delete button, wired to
     the Step 4 endpoints, with a confirmation dialog before delete (reuse
     `web/src/components/ConfirmContext.tsx`).
3. The server remains the enforcement point. The UI gating is convenience;
   never assume hiding a button is security.

### Step 6 — Tests

1. Extend `server/src/routes/authCoverage.test.ts` (follow its existing
   style) with a role-coverage table: for each (route, verb) in the Step 3
   table, assert that a `viewer` token gets 403 on mutating routes and 200/
   expected on GETs, and that an `operator` token gets 403 on admin-only
   routes. Use supertest against `createApp()` — the pattern already exists
   in the test file.
2. Add `server/src/rbac.test.ts` unit tests for `requireRole` itself:
   admin-implicit-allow, missing `req.authUser` → 500, disallowed → 403.
3. Test the last-admin guard and first-user-is-admin logic.
4. Test that a JWT **without** a role claim (mint one in the test with
   `jwt.sign({ userId, email }, secret)`) still authenticates and receives
   the DB row's role — this is the backwards-compatibility guarantee.

## Things you must NOT do

- Do not add a permissions framework/library (no casbin, no accesscontrol).
  Three roles and one middleware factory. Keep it boring.
- Do not store roles in the JWT as the source of truth (DB row wins).
- Do not break the consumer token flow (`/api/auth/consumer`) — after your
  change, run its existing tests and confirm the deploy workflow's PATCH of
  issues would still be authorized (that PATCH goes through
  `/api/assistant/issues/:id` with the consumer JWT; the consumer must
  resolve to an admin-role identity).
- Do not touch the unauthenticated bucket-object GET in
  `server/src/index.ts` (that is a separate, known issue with its own fix).

## Acceptance criteria

1. `users.role` column exists, defaulting existing rows to `admin`.
2. All routes enforce the Step 3 table server-side; the coverage test proves
   it mechanically (a new route added later without a role annotation should
   make a reviewer's eyebrow rise via the table test).
3. Old (role-less) JWTs still work; role changes apply without re-login.
4. Last-admin cannot be demoted or deleted; users cannot delete themselves.
5. UI hides what the role cannot do; Settings has a Users manager for admins.
6. `npm run typecheck`, `npm test`, and `npm run lint` all pass at the root.

## Verification

```bash
npm run typecheck
npm test
npm run lint
```

Then manually (document the output in the PR description):

```bash
# with a dev server running and three users seeded, one per role:
curl -s -X POST localhost:4300/api/containers/whatever/stop -H "Authorization: Bearer $VIEWER_TOKEN" | grep -q 'Requires role' && echo VIEWER-BLOCKED-OK
curl -s -X POST localhost:4300/api/images/prune -H "Authorization: Bearer $OPERATOR_TOKEN" | grep -q 'Requires role' && echo OPERATOR-BLOCKED-OK
```

## Commit and push

Commits per step (`feat(gap-01): ...`), then:

```bash
git push -u origin gap/01-rbac
```

Open a PR titled `feat: role-based access control (admin/operator/viewer)`.
The PR description must include the Step 3 policy table verbatim and the
backwards-compatibility explanation from Step 2.
