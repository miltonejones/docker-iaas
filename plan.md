# Assistant Manifest Awareness

Give the Dockyard assistant tools and system-prompt guidance to read and
capture a project's resource manifest, so it can act responsibly around
manifest-protected resources instead of being blind to the feature entirely.

## Context

`gap/13-project-manifest-protection` added a capture-only manifest per
project (`PUT/GET /api/projects/:id/manifest`, `GET /:id/manifest/drift`)
and a hard-block on delete/route-target-change for non-admin users whose
target resource is referenced in any project's manifest. `admin` bypasses
the block by design, and the assistant's consumer JWT inherits the first
user's role — which is always `admin` (see `createUser` in `db.ts`). So in
practice the assistant is never blocked by this feature.

The problem: the assistant currently has **zero tools or prompt awareness**
of manifests. Its only project tools are `list_projects`, `create_project`,
`update_project`, `delete_project` (`server/src/assistant-tools.ts`). It
can't capture a manifest, read one, or check drift — and because it bypasses
protection silently, it can delete or reconfigure a project-managed resource
without ever knowing (or telling the user) that the resource was "managed."
That's a bad experience: a user captures a manifest expecting some
friction around a resource, then asks the assistant to "clean up unused
containers" and the assistant deletes it without a second thought.

## Reasoning / design decisions

- **Don't change the bypass.** The admin-bypass-skips-protection design from
  gap/13 stays as-is — reversing it would block the assistant from routine
  work on the user's own projects, which isn't the goal here.
- **Awareness over enforcement.** The fix is to give the assistant the
  *information* (via read-only lookup tools) and *behavioral guidance* (via
  the system prompt) to check manifest membership before destructive
  actions and mention it to the user — not to add a second enforcement
  layer in code. This mirrors how the assistant already handles the
  `dockyard-knowledge` bucket notes: check first, then act thoughtfully.
- **Expose capture as a tool.** Users should be able to say "capture a
  manifest for this project" in chat, same as they can create/delete a
  project today.
- **Read-only lookups auto-resolve.** `get_project_manifest` and
  `get_manifest_drift` have no side effects, so — matching every other
  lookup tool (`list_projects`, `read_function`, etc.) — they should run
  server-side and loop back to Claude immediately, without a client
  confirmation prompt. `capture_project_manifest` mutates `projects.manifest`
  in the DB, so it follows the same confirm-then-execute flow as
  `create_project`/`delete_project`.
- **Three wiring surfaces, not one.** This codebase exposes tools to three
  different callers from one shared schema (`server/src/tool-schemas.ts`):
  the interactive browser assistant (`AssistantBar.tsx`, HTTP calls through
  `api.ts`), the server's own read-only fast-path (`routes/assistant.ts`),
  and the standalone MCP server (`mcp/src/handlers.ts`, which calls
  `projectService` directly, bypassing HTTP/role checks — same as
  `create_project`/`delete_project` already do there). All three need their
  own case for each new tool; missing one silently breaks that surface only.

## New tools

| Tool | Type | Service call | Notes |
|---|---|---|---|
| `get_project_manifest` | read-only, auto-resolved | `projectService.getManifest(id, userId)` | Mirrors `GET /:id/manifest`. Returns `{ error: ... }` shape on 404 (no manifest captured) rather than throwing, matching the `read_function`/`get_issue` not-found pattern. |
| `get_manifest_drift` | read-only, auto-resolved | `projectService.getManifestDrift(id, userId)` | Mirrors `GET /:id/manifest/drift`. Same not-found handling. |
| `capture_project_manifest` | confirm-required | `projectService.captureManifest(id, userId)` (service) / `api.projectCaptureManifest(id)` (client) | Mirrors `PUT /:id/manifest`. Destructive-ish in the sense that it *freezes new protection*, but not data-destructive — do not add it to `AssistantBar.tsx`'s `DESTRUCTIVE` set. |

## Instructions

### 1. `server/src/tool-schemas.ts` — add schemas

In `PROJECT_TOOLS` (around line 757), add after `list_projects`:

```ts
{
  name: 'get_project_manifest',
  description: 'Get a project\'s captured manifest.',
  properties: { id: { type: 'string', description: 'Project ID' } },
  required: ['id'],
},
{
  name: 'get_manifest_drift',
  description: 'Compare a project\'s captured manifest against live resource state.',
  properties: { id: { type: 'string', description: 'Project ID' } },
  required: ['id'],
},
{
  name: 'capture_project_manifest',
  description: 'Capture a snapshot of a project\'s currently linked resources.',
  properties: { id: { type: 'string', description: 'Project ID' } },
  required: ['id'],
},
```

This one change also updates the MCP tool list for free (`mcp/src/tools.ts`
maps `COMMON_TOOL_SCHEMAS` straight through `toMcpSchema`).

### 2. `server/src/assistant-tools.ts` — Claude-optimized descriptions

Add to `ASSISTANT_DESCRIPTIONS` near the existing `list_projects`/
`create_project`/etc. entries:

```ts
get_project_manifest:
  "Get the captured manifest for a project — the JSON snapshot of resources (containers, routes, functions, buckets, databases) taken the last time capture_project_manifest ran. Resources listed in ANY project's manifest cannot be deleted, and routes in one cannot have their target port changed, by non-admin users — check this before deleting or reconfiguring a resource that might belong to a project, and mention the protection to the user if it applies. Read-only, runs automatically. Returns an error if the project has no captured manifest yet.",
get_manifest_drift:
  "Compare a project's captured manifest against live resource state. Returns { synced, missing, changed, orphaned } — missing entries no longer exist, changed entries have diverged (e.g. env vars or target changed since capture), orphaned entries are linked to the project but weren't captured. Use this to tell the user when a project's manifest is stale and suggest re-running capture_project_manifest. Read-only, runs automatically. Returns an error if the project has no captured manifest yet.",
capture_project_manifest:
  "Snapshot every resource currently linked to a project (containers, routes, functions, buckets, databases) into that project's manifest. Resources in the manifest become protected: non-admin users can no longer delete them or change a route's target port until the resource is unlinked from the project. Re-running this replaces the previous snapshot. The user confirms before capture runs.",
```

### 3. `server/src/routes/assistants.ts` — category registry

Add the three names to `TOOL_CATEGORIES.Projects` (line ~23):

```ts
'Projects': ['list_projects', 'create_project', 'update_project', 'delete_project', 'get_project_manifest', 'get_manifest_drift', 'capture_project_manifest'],
```

**Required** — `custom-assistants.test.ts` has a registry-walk test
("every tool in assistant-tools.ts is assigned a category in
TOOL_CATEGORIES") that fails otherwise.

### 4. `server/src/routes/assistant.ts` — read-only execution + prompt

- Add to `READ_ONLY_TOOLS` (line ~216, next to `list_projects`):
  ```ts
  "get_project_manifest",
  "get_manifest_drift",
  ```
- Add cases to `executeReadOnlyTool()` (next to the `list_projects` case,
  line ~318), following the `read_function`/`get_issue` not-found
  convention (return an `{ error }` object rather than throwing, since a
  thrown `HttpError` here would surface as a raw tool error to Claude
  instead of a clean message it can relay):
  ```ts
  case "get_project_manifest": {
    try {
      return projectService.getManifest(String(input.id ?? ""), userId);
    } catch (err) {
      return { error: err instanceof HttpError ? err.message : "Failed to read manifest." };
    }
  }
  case "get_manifest_drift": {
    try {
      return await projectService.getManifestDrift(String(input.id ?? ""), userId);
    } catch (err) {
      return { error: err instanceof HttpError ? err.message : "Failed to compute drift." };
    }
  }
  ```
  (Confirm `HttpError` is already imported in this file — it's used
  elsewhere for other services' not-found handling; if not, import it from
  `../services/HttpError.js`.)
- Do **not** add `capture_project_manifest` here — it mutates state, so it
  must go through the client confirm flow like `create_project`.
- Extend `SYSTEM_PERSONA`'s existing "Projects organize resources..."
  paragraph (line ~126) with a short addition, e.g.:
  > Some projects have a captured manifest — a snapshot taken by
  > capture_project_manifest of the resources linked to them at that
  > moment. Resources in a manifest are hard-blocked from deletion (and,
  > for routes, from a target-port change) for non-admin users; you bypass
  > this as admin, so nothing will stop you technically, but you should
  > still be careful. Before deleting or reconfiguring a resource that
  > might belong to a project, call get_project_manifest for that project
  > and check whether the resource is listed — if it is, tell the user
  > it's project-managed before proceeding rather than silently acting.
  > If a project's manifest looks stale (call get_manifest_drift to check),
  > suggest re-running capture_project_manifest rather than doing it
  > unprompted.

  Keep the existing blank-line separator between `SYSTEM_PERSONA` and
  `SYSTEM_CORE` intact — `custom-assistants.test.ts` asserts on it.

### 5. `web/src/components/AssistantBar.tsx` — client wiring

- Add to `ACTION_LABEL` (near `create_project`/`update_project`/
  `delete_project`, line ~78):
  ```ts
  capture_project_manifest: 'Capture project manifest',
  ```
- Add a dispatch case near the existing project cases (line ~1356):
  ```ts
  case 'capture_project_manifest':
    return api.projectCaptureManifest(String(input.id ?? ''));
  ```
- Optional but consistent with the existing defense-in-depth pattern for
  other read-only tools (see the `get_issue`/`list_issues` cases around
  line 1371) — add `get_project_manifest`/`get_manifest_drift` to that same
  "auto-resolved server-side" block so a client that somehow receives one
  as pending doesn't error out.
- Do **not** add `capture_project_manifest` to the `DESTRUCTIVE` set — it
  doesn't delete or destroy anything, it only starts protecting things.

### 6. `mcp/src/handlers.ts` — MCP dispatch

Add three cases under the existing `// ── Projects ──` section (line
~333), following the same direct-service-call pattern as
`list_projects`/`create_project`:

```ts
case 'get_project_manifest':
  result = projectService.getManifest(args.id as string, userId);
  break;
case 'get_manifest_drift':
  result = await projectService.getManifestDrift(args.id as string, userId);
  break;
case 'capture_project_manifest':
  result = await projectService.captureManifest(args.id as string, userId || '');
  break;
```

(No role gate here, same as `create_project`/`delete_project` in this file
today — MCP is a trusted local context, not the browser session.)

## Constraints

- Don't touch `scripts/issue-consumer.mjs`, `Dockerfile.consumer`,
  `docker-compose.yml`, or `.gitignore` (repo-wide protected files).
- Don't add a new tool category — `Projects` already exists and is the
  right home for these three.
- Don't change the admin-bypass behavior from gap/13; this is additive
  awareness only.
- Match existing code style in each file (the tool schema/description/
  dispatch patterns above are copied directly from neighboring entries).

## Testing plan

- `custom-assistants.test.ts`'s registry-walk test will fail until
  `TOOL_CATEGORIES.Projects` includes all three new names — run
  `npm --workspace server test` after step 3 to confirm.
- No existing test exercises `executeReadOnlyTool` or
  `mcp/src/handlers.ts` directly; manual verification is the norm here
  (matches current coverage for `list_projects` et al.). Optionally export
  `executeReadOnlyTool` for a light unit test covering the two new cases
  (not required to match existing conventions, but worth considering since
  this is new branching logic with its own not-found handling).
- Manually verify in the browser: ask the assistant to capture a
  project's manifest, then ask it to delete a resource that's now in that
  manifest — it should mention the resource is project-managed before
  proceeding (it will still succeed, since it's admin — the point is the
  narration, not a new block).
- `npm run typecheck` and `npm run lint` across the repo after all edits.
