# Rewrite MCP as a REST API Client

Stop the `mcp` workspace from importing Dockyard's service layer directly,
and make it a thin, authenticated HTTP client instead — like the CLI, and
like the web console.

**Priority note: this is the lowest-priority phase of the three and is safe
to defer indefinitely.** Unlike [[16-api-key-auth]] and [[17-cli]], which are
each independently useful the day they ship (self-serve keys; a working
CLI), this gap is a pure internal refactor — everything MCP can do today (in
its current same-machine-only mode) it can still do after this change. Do
this one last, and only once the other two have landed and settled.

## Context

`mcp/src/handlers.ts` currently has ~50+ `switch` cases, every single one
calling `server/src/services/*` functions directly, in-process
(`result = await containerService.list(userId, ...)`). Per `mcp/README.md`,
this is by design — it "does not make HTTP calls to the REST API." That
design has two real costs:

1. **MCP can only manage a Dockyard instance it's co-located with.** It
   shares the same SQLite file, Docker socket, and MinIO client as whatever
   server process it's running alongside — it can never point at a remote
   or containerized Dockyard instance.
2. **It's a second, independent copy of every tool's wiring**, on top of
   the REST API and the assistant's tool dispatch — exactly the "three
   wiring surfaces" problem named in gap/14's plan.md, except MCP is really
   a *fourth* surface once you count the browser assistant, the REST routes
   themselves, and (per [[17-cli]]) the CLI.

Both problems disappear if MCP becomes "just another authenticated HTTP
client of the REST API" — the same role the CLI plays. This requires
[[16-api-key-auth]] to exist first: MCP's `DOCKYARD_API_KEY` env var
currently only checks against the single shared `CONSUMER_API_KEY`, which
isn't a real per-installation credential.

## Reasoning / design decisions

- **This is not a purely mechanical refactor — flag the behavior change.**
  Today, MCP's direct service calls bypass every route-level
  `requireRole`/`requireWrite` gate and gap/13's manifest-protection checks,
  because those live in the route/middleware layer, not the service layer.
  MCP today is, in effect, always-admin regardless of which user/token it's
  configured with. After this rewrite, an MCP client authenticated with a
  `viewer`- or `operator`-scoped API key will correctly receive real `403`s
  it silently didn't get before. This is *more correct* — auth starts
  meaning something for MCP callers — but it is a genuine behavior change
  for anyone currently relying on MCP + a low-privilege credential to
  perform writes. They will need an operator/admin-scoped key going
  forward. Call this out prominently when this gap ships (release notes /
  PR description), not just in code comments.
- **`mcp/src/auth.ts` shrinks dramatically, it doesn't get "extended."**
  Today it does real work: verifying `DOCKYARD_JWT` against a locally-loaded
  `JWT_SECRET`, or checking `DOCKYARD_API_KEY` against `CONSUMER_API_KEY`,
  then looking up a user directly in the DB. None of that is MCP's job once
  auth happens server-side via the `Authorization` header — MCP just needs
  to forward whichever token it was configured with. Since
  [[16-api-key-auth]]'s `requireAuth` already disambiguates a JWT from a
  `dky_` API key by prefix, MCP doesn't need its own branching logic either
  — it can accept either `DOCKYARD_API_KEY` or `DOCKYARD_JWT`, pick whichever
  is set, and send it verbatim as the bearer token. This is a net
  simplification, not new complexity.
- **`initDb()`/`ensureNetwork()`/`ensureMinio()` all get deleted from
  `mcp/src/index.ts`.** They exist today only because MCP shares
  process-local state with the server. A pure HTTP client has no reason to
  touch Docker, MinIO, or SQLite directly — this is one of the largest
  simplifications of the rewrite, and it also means `mcp/`'s dependency on
  `server/src/*` internals (via relative imports) goes away entirely.
- **Duplicate the `request()` client helper from [[17-cli]]; don't extract a
  shared package.** The helper is ~15 lines (see the CLI's `client.ts`).
  This repo has no existing shared-internal-package precedent — introducing
  one now (`packages/dockyard-client/`, its own `package.json`/`tsconfig`/
  build step) to save duplicating 15 lines would reintroduce a version of
  the tight-coupling problem this whole effort exists to remove, just moved
  one level: both `cli` and `mcp` would now depend on a third package's
  build/release timing instead of on `server/src/*` directly. Revisit
  extraction only if the two clients' needs grow into something bigger than
  a thin `request()` wrapper (e.g. a full typed method-per-resource client)
  — not assumed for this gap.
- **New `DOCKYARD_API_URL` env var, matching the CLI's naming.** Default
  `http://localhost:4300`. A CI pipeline (or a developer's shell profile)
  can set `DOCKYARD_API_URL`/`DOCKYARD_API_KEY` once and have both the CLI
  and MCP pick them up identically — deliberate naming symmetry with
  [[17-cli]]'s config resolution.

## Implementation steps

### 1. New client helper — `mcp/src/client.ts`

Same shape as `cli/src/client.ts` (duplicated, per the reasoning above):

```ts
export interface DockyardClientConfig { apiUrl: string; apiKey: string; }

export async function request<T>(config: DockyardClientConfig, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}
```

Config resolution: `DOCKYARD_API_URL` (default `http://localhost:4300`) +
whichever of `DOCKYARD_API_KEY` / `DOCKYARD_JWT` is set (either one becomes
the bearer token — the server decides which kind it is).

### 2. Rewrite `mcp/src/handlers.ts` case-by-case

Mechanical once the pattern is established. Three representative examples:

**Simple read:**
```ts
// Before
case 'list_containers':
  result = await containerService.list(userId, args.projectId as string | undefined);
  break;

// After
case 'list_containers':
  result = await client.request(config, 'GET', `/api/containers${args.projectId ? `?projectId=${args.projectId}` : ''}`);
  break;
```

**Mutation with a path param:**
```ts
// Before
case 'delete_container':
  result = await containerService.remove(args.id as string, userId, args.force as boolean);
  break;

// After
case 'delete_container':
  result = await client.request(config, 'DELETE', `/api/containers/${args.id}${args.force ? '?force=true' : ''}`);
  break;
```

**One where the behavior genuinely changes** (see Constraints — this is the
case to point to when explaining the auth-boundary change):
```ts
// Before — bypasses gap/13's manifest-protection check and any role gate,
// since it calls the service layer directly.
case 'delete_project':
  result = await projectService.remove(args.id as string, userId);
  break;

// After — goes through the real route, so requireWrite/requireRole and the
// manifest-protection HttpError now apply exactly as they would for any
// other client.
case 'delete_project':
  result = await client.request(config, 'DELETE', `/api/projects/${args.id}`);
  break;
```

Every remaining case follows one of these three shapes — verb/path taken
directly from the corresponding `routes/*.ts` file, not invented.

### 3. Shrink `mcp/src/auth.ts`

Delete the DB/JWT-verification logic entirely. What remains: read
`DOCKYARD_API_URL`, `DOCKYARD_API_KEY`, `DOCKYARD_JWT` from env and build a
`DockyardClientConfig`. No `getUserById`/`getFirstUser`/`jwt.verify` calls,
no `jsonwebtoken` import, no DB import in `mcp/` at all anymore.

### 4. Fix `DOCKYARD_ASSISTANT_ID` tool filtering

`mcp/src/index.ts` currently calls `getUserAssistant(id, userId)` directly
against the DB to filter the exposed tool list for a given
`DOCKYARD_ASSISTANT_ID`. **Before assuming new work is needed**, check
`server/src/routes/assistants.ts` for an existing `GET /api/assistants/:id`
route — if it exists, swap the direct DB call for
`client.request(config, 'GET', `/api/assistants/${id}`)`. If it doesn't
exist yet, adding it is in-scope for this gap (required to preserve
existing behavior, not scope creep).

### 5. Trim `mcp/src/index.ts` startup

Remove the `initDb()`, `ensureNetwork()`, `ensureMinio()` calls — MCP no
longer needs Docker/MinIO/SQLite access once every tool call is an HTTP
request. Confirm `mcp/package.json`'s dependencies can drop anything that
was only there to support those direct imports.

## Files summary

| File | Change |
|---|---|
| `mcp/src/client.ts` | New — duplicated `request()` helper |
| `mcp/src/handlers.ts` | Rewrite all ~50+ cases to `client.request(...)` calls |
| `mcp/src/auth.ts` | Shrink to env-var reading only |
| `mcp/src/index.ts` | Remove `initDb`/`ensureNetwork`/`ensureMinio`; fix assistant-filter lookup |
| `mcp/package.json` | Drop dependencies only needed for direct service-layer access |

## Constraints

- **Document the role-boundary behavior change** (see Reasoning) in the PR
  description / release notes for this gap — this is the one thing in this
  plan that isn't purely additive/internal.
- Do NOT extract a shared client package for `cli`/`mcp` in this gap —
  duplicate the ~15-line helper, per the reasoning above.
- Do NOT invent new REST endpoints beyond the one needed for step 4 (the
  assistant-lookup fallback) — every other case should map onto a route
  that already exists.
- Confirm `npm --workspace mcp run typecheck` passes with all
  `server/src/*` relative imports removed — a good mechanical check that
  the decoupling is complete, not partial.

## Testing plan

Manual, against a throwaway dev instance — but this time genuinely
exercising MCP's *new* capability (pointing at a different host), not just
same-machine loopback:

1. Start the dev server normally (default port 4300).
2. Mint an API key via [[16-api-key-auth]] for a test user.
3. Run `mcp/` with `DOCKYARD_API_URL=http://localhost:4300
   DOCKYARD_API_KEY=dky_...` and connect an MCP client (Claude Desktop
   config, or a manual stdio test script) — call `list_containers`,
   `create_bucket`, `delete_bucket` and confirm results match what the same
   actions via curl/CLI/web console show (all surfaces now hit the
   identical route).
4. Deliberately test the role-boundary change: use an `operator`-scoped
   key, attempt an admin-gated tool (e.g. something behind
   `requireRole('admin')`), confirm MCP now correctly surfaces a permission
   error instead of silently succeeding.
5. Confirm `DOCKYARD_ASSISTANT_ID` tool-list filtering still works
   end-to-end after its auth path changes.
6. If feasible, point `DOCKYARD_API_URL` at a Dockyard instance on a
   different host/container and confirm MCP tool calls succeed over the
   network — this is the actual new capability this gap unlocks and should
   be verified directly, not just assumed from the code shape.
7. Clean up any test buckets/containers/API keys created during
   verification.
8. `npm --workspace mcp run typecheck`.
