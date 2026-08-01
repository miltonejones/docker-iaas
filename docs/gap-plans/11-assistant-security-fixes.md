# Prompt 11 — Assistant subsystem security fixes (session ownership, scoped tools, fail-closed assistants)

You are an LLM coding agent working in `miltonejones/docker-iaas` (project
**Dockyard**). This prompt fixes four confirmed security defects in the
assistant subsystem, found in a code review dated 2026-08-01. They are real,
verified bugs — not hypotheticals. Fix them exactly as specified. This prompt
is **security-critical**: do not improvise, do not expand scope, and do not
"improve" adjacent code while you are in there.

## Global rules you must obey

- Branch: `gap/11-assistant-security`, created from latest `origin/main`.
  Never push to `main`. Never force-push.
- Protected files — do NOT touch: `Dockerfile.consumer`, `docker-compose.yml`,
  `docker-compose.ci.yml`, `Caddyfile`, `.gitignore`,
  `.github/workflows/deploy.yml`, `scripts/issue-consumer.mjs`,
  `scripts/protected-files.json`, `scripts/smoke-test-hardening.sh`.
- Do not remove the `playwright` dependency.
- Zero new npm dependencies.
- Run the verification commands after each step; never build on a failure.
- Every fix in this prompt gets a regression test written in the SAME step as
  the fix, not deferred to the end.

## Read these files fully before writing any code

1. `server/src/routes/assistant.ts` — the chat pipeline. Find: the
   `/sessions/:id` PUT and DELETE handlers, the `/sessions/:id/abort`
   handler, `streamTurn` (search for `safeExecuteReadOnly`), and
   `resolveAssistantOpts`.
2. `server/src/db/assistantSessions.ts` — session CRUD. Note that
   `updateAssistantSession` and `deleteAssistantSession` take NO user
   parameter today.
3. `server/src/routes/assistants.ts` + `server/src/services/assistants.ts` —
   custom assistant CRUD (correctly ownership-scoped; use as the reference
   pattern).
4. `server/src/routes/authCoverage.test.ts` — existing test conventions
   (supertest against `createApp()`).
5. `server/src/sessionRunner.ts` — the session registry and runner.

## Background: the four defects

- **Defect A — Session IDOR.** `GET /api/assistant/sessions/:id` checks
  ownership (`getAssistantSession(id, userId)` returns undefined on a user
  mismatch), but `PUT /sessions/:id`, `DELETE /sessions/:id`, and
  `POST /sessions/:id/abort` do not. Any authenticated user can rename,
  overwrite the state of, reassign the assistant of, delete, or abort any
  other user's session. The DB helpers `updateAssistantSession(id, fields)`
  and `deleteAssistantSession(id)` have no ownership parameter at all.
- **Defect B — Weak session IDs.** Sessions are created with
  `` `asn-${Math.random().toString(36).slice(2, 8)}` `` — six base-36
  characters (~31 bits) from a non-cryptographic RNG. Combined with Defect A
  this makes blind guessing of other users' sessions plausible.
- **Defect C — Unscoped read-only tool execution.** `executeReadOnlyTool(name,
  input, userId)` accepts a userId and the underlying services filter by it
  (e.g. `containerService.list(userId)` filters on the `iaas.owner` label).
  But `streamTurn` calls `safeExecuteReadOnly(b.name, b.input)` — **without
  the userId** — in BOTH places it appears (the mixed read/mutate branch and
  the all-read-only branch). Result: any user's chat lists every user's
  containers, functions, buckets, gateway routes, issues, etc.
- **Defect D — Fail-open custom assistants.** `resolveAssistantOpts` returns
  `undefined` when the assistant is not found (deleted, or belongs to another
  user) or when any unexpected error occurs. `undefined` means "use the
  built-in SYSTEM prompt and the FULL tool set" — so a session bound to a
  deliberately restricted assistant silently escalates to the unrestricted
  default the moment that assistant is deleted. Restriction failures must be
  fail-closed and visible.

## Step-by-step instructions

### Step 1 — Fix Defect A (session ownership on every verb)

1. In `server/src/db/assistantSessions.ts`:
   - Change `updateAssistantSession(id, fields)` to
     `updateAssistantSession(id, fields, userId?: string)`. When `userId` is
     provided, the ownership check must match the semantics `getAssistantSession`
     already uses: a row whose `user_id` differs from the caller is treated as
     not found (return `undefined`). Keep the parameter optional ONLY because
     the SessionRunner persists state server-side on behalf of the session it
     already validated (`sessionRunner.ts` → `persistState`) — that internal
     call may keep passing no userId. Add a doc comment on the parameter
     saying exactly that: "optional only for internal, already-authorized
     callers; HTTP handlers must always pass it."
   - Change `deleteAssistantSession(id)` to
     `deleteAssistantSession(id, userId?: string)` with the same semantics:
     when userId is provided, `DELETE ... WHERE id = ? AND (user_id = ? OR user_id IS NULL)`
     — read the next paragraph before deciding how to treat `user_id IS NULL`.
   - **Legacy NULL-owner sessions**: rows created before the user_id
     migration have `user_id IS NULL`, and `listAssistantSessions` currently
     shows them to everyone. Decide NOTHING yourself — implement this exact
     policy: NULL-owner sessions are readable by everyone (unchanged),
     mutable/deletable by everyone (matches the current listing behavior),
     BUT on any successful authenticated PUT of a NULL-owner session, claim
     it: set `user_id` to the caller. This ratchets legacy rows toward real
     ownership without a migration. Implement the claim inside
     `updateAssistantSession` when `userId` is passed and the row's user_id
     is NULL. Document it in a comment.
2. In `server/src/routes/assistant.ts`:
   - `PUT /sessions/:id`: pass `getAuthUser(req)?.userId` through.
   - `DELETE /sessions/:id`: same.
   - `POST /sessions/:id/abort`: before touching the registry, load the
     session with `getAssistantSession(req.params.id, getAuthUser(req)?.userId)`
     and 404 if it comes back undefined — identical shape to the GET
     handler's check. Only then call `runner.abort()`.
   - `POST /sessions/:id/send` and `GET /sessions/:id/stream` already load
     the row with the userId — verify by reading, do not change them.
3. Tests (add `server/src/routes/assistantSessions.test.ts`, supertest
   against `createApp()`, two users seeded): user B PUTs / DELETEs / aborts
   user A's session → 404 (not 403 — do not reveal existence); user A can
   still do all three; a NULL-owner session is claimable by whoever PUTs it
   first, and afterwards the other user gets 404.

### Step 2 — Fix Defect B (session ID entropy)

1. In the `POST /sessions` handler, replace the `Math.random` ID with
   `` `asn-${crypto.randomBytes(9).toString('base64url')}` `` (12 URL-safe
   chars, 72 bits). Import `crypto` from `node:crypto` at the top of the
   file if not already imported. Note the custom-assistant IDs already use
   exactly this pattern (`ast-` + `crypto.randomBytes(8).toString('hex')` in
   `db.ts`) — you are bringing sessions up to the established idiom.
2. Do NOT migrate existing session IDs — old sessions keep their IDs; the
   ownership checks from Step 1 are what protects them now.
3. Test: create a session, assert the ID matches
   `/^asn-[A-Za-z0-9_-]{12}$/`.

### Step 3 — Fix Defect C (scope auto-executed read-only tools)

1. In `streamTurn` (in `server/src/routes/assistant.ts`), find both calls to
   `safeExecuteReadOnly(b.name, b.input as Record<string, unknown>)` — one
   in the branch where mutating calls are pending (`autoResolved`), one in
   the all-read-only loop. `streamTurn` already receives `userId` as its
   first parameter. Pass it to both calls:
   `safeExecuteReadOnly(b.name, b.input as Record<string, unknown>, userId)`.
2. Trace `userId`'s value at the callers, and be pedantic about it:
   - `respondStream` calls `streamTurn(getAuthUser(req)?.userId ?? 'deploy', …)`.
     The `'deploy'` fallback exists because these routes are mounted behind
     `requireAuth`, so authUser should always exist; the fallback is
     dead-code safety. Leave it, but confirm `/api/assistant` is mounted
     with `requireAuth` in `server/src/index.ts` (it is — verify).
   - `SessionRunner.send` calls `respondStream(this.userId ?? 'deploy', …)`.
     Same reasoning.
3. Read `executeReadOnlyTool` end to end and list, in your PR description,
   every case that consumes the userId (e.g. `list_containers`,
   `list_functions`, `list_gateway_routes`, `list_buckets`,
   `list_projects`, `list_issues`, `get_issue`,
   `check_gateway_domain_status`) versus every case that ignores it (e.g.
   `list_images`, `list_volumes`, host/consumer tools). For the ignoring
   cases, do NOT invent per-user scoping in this prompt — resource ownership
   filtering beyond what services already support is prompt 01 (RBAC)
   territory. Your job here is only to stop dropping the userId on the
   floor.
4. Tests: in a new `server/src/assistantToolScoping.test.ts`, unit-test that
   `safeExecuteReadOnly('list_issues', {}, userA)` returns only user A's
   issues when issues from two users exist (the issues store is SQLite, no
   Docker needed — seed via `createAssistantIssue`). Add one more test
   proving the regression cannot silently return: grep-style assertion is
   not enough — instead export a tiny wrapper or spy-friendly seam if
   needed, but prefer the direct data-driven test.

### Step 4 — Fix Defect D (fail closed when the assistant can't be resolved)

1. Change `resolveAssistantOpts` semantics. New contract, exactly:
   - No `assistantId` supplied → return `undefined` (built-in default
     assistant; unchanged — selecting no assistant is a legitimate choice).
   - `assistantId` supplied and found → return `{ system, tools }` as today.
   - `assistantId` supplied and NOT found (404) or ANY error → **throw** an
     `HttpError(410, 'Assistant <id> no longer exists (it may have been deleted). This session is bound to it — pick another assistant or clear the session's assistant.')`
     (import `HttpError` from `../services/HttpError.js`; use 410 Gone so
     the client can distinguish "assistant gone" from generic 404s).
2. Update every caller to surface that error instead of swallowing it:
   - `/plan` and `/confirm`: the try/catch already returns 500s; make sure
     an HttpError's `status` propagates (these handlers currently hardcode
     500 — use the same `sendError`-style status extraction the assistants
     router uses).
   - `GET /sessions/:id/stream` and `POST /sessions/:id/send`: resolve opts
     BEFORE creating/getting the runner (already the case); on throw,
     respond with the error's status + message instead of streaming.
3. Client (`web/src/components/AssistantBar.tsx`): when a plan/confirm/send
   call fails with status 410, show the server's message as the error AND
   reset `activeAssistantId` to `null` so the user's next attempt uses the
   default assistant *explicitly* rather than silently. Also clear the
   session's stored `assistantId` via the existing session-update API call
   path when the user proceeds. Find the existing error-display state
   (`setError`) and reuse it; no new UI surfaces.
4. Also fix the same fail-open in the OTHER consumer of assistant configs:
   `mcp/src/index.ts` (if the `mcp/` workspace exists on your branch — it is
   restored by prompt 00) filters tools via `getUserAssistant` and silently
   serves ALL tools when the assistant row is missing. Apply the same
   fail-closed rule there: assistant specified but missing → serve zero
   tools and log an error. If `mcp/` does not exist in the working tree,
   skip this and note it in the PR description.
5. Tests: session bound to a since-deleted assistant → `/sessions/:id/send`
   returns 410 with the message; `/plan` with a bogus assistantId → 410;
   no assistantId → still works with defaults.

### Step 5 — Document the trust model honestly (no code)

Add a short section to `README.md` under the assistant docs: a custom
assistant's tool list constrains which tools are OFFERED to the model, but
mutating tools are executed by the browser with the signed-in user's full
API authority after per-call confirmation — the tool list is a UX shaping
mechanism, not a security boundary; the security boundary is the user's own
JWT (and, once prompt 01 lands, their role). One paragraph, plainly worded.
Do not attempt to build server-side per-assistant tool enforcement in this
prompt — that requires the server to execute mutating tools itself, which
is a large architectural change; note it as possible future work in the PR
description instead.

## Things you must NOT do

- Do not refactor `streamTurn`, the SSE plumbing, or the runner lifecycle.
- Do not change the `/plan`+`/confirm` vs `/send`+`/stream` duality (that is
  prompt 12's concern to document, and a human decision to consolidate).
- Do not add per-assistant server-side mutation enforcement (see Step 5).
- Do not migrate or rewrite existing session rows beyond the NULL-owner
  claim-on-write rule.
- Do not touch the issue-consumer PATCH path (`x-consumer-api-key` service
  access in the issues routes) — it is intentional service auth.

## Acceptance criteria

1. PUT/DELETE/abort on someone else's session → 404; owner unaffected;
   NULL-owner sessions claimable exactly once.
2. New session IDs are 72-bit crypto-random.
3. Both `safeExecuteReadOnly` call sites pass the userId; the two-user
   issues test proves scoping.
4. A missing/deleted custom assistant fails closed with 410 end-to-end
   (server throws, client surfaces and resets), never silently falling back
   to the full tool set; same rule applied in `mcp/` if present.
5. README documents the tool-list trust model.
6. `npm run typecheck`, `npm test`, `npm run lint` pass; all new tests are
   in the default `npm test` path.

## Verification

```bash
npm run typecheck && npm test && npm run lint
# Targeted:
npm --workspace server run test 2>&1 | grep -Ei "assistantSessions|assistantToolScoping" 
```

Paste the targeted test output into the PR description, plus the Step 3
consumes/ignores userId listing.

## Commit and push

One commit per step (`fix(gap-11): ...` for Steps 1-4, `docs(gap-11): ...`
for Step 5), then `git push -u origin gap/11-assistant-security`; PR title
`fix: assistant session ownership, scoped tool reads, fail-closed custom assistants`.
The PR description must begin: `Security fixes — review each step against
its defect description in docs/gap-plans/11-assistant-security-fixes.md.`
