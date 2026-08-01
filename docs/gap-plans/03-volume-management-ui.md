# Prompt 03 — Volume management page in the web UI

You are an LLM coding agent working in `miltonejones/docker-iaas` (project
**Dockyard**). The server already has a volumes API
(`server/src/routes/volumes.ts` + `server/src/services/volumes.ts`), but the
web UI has **no page for volumes** — the README itself lists "volume
management UI" as a missing next step. Your task: build that page, and fill
any small server-side holes it exposes. UI-first task; server changes only
where listed.

## Global rules you must obey

- Branch: `gap/03-volume-ui` from latest `origin/main`. Never push to `main`.
  Never force-push.
- Protected files — do NOT touch: `Dockerfile.consumer`, `docker-compose.yml`,
  `docker-compose.ci.yml`, `Caddyfile`, `.gitignore`,
  `.github/workflows/deploy.yml`, `scripts/issue-consumer.mjs`,
  `scripts/protected-files.json`, `scripts/smoke-test-hardening.sh`.
- Do not remove the `playwright` dependency.
- Match the existing UI exactly: same CSS conventions (`web/src/styles.css`
  utility classes / BEM-ish names — read how `Buckets.tsx` and
  `Instances.tsx` are styled and copy), same data-fetch idiom
  (`web/src/api.ts` helpers), same confirm dialog
  (`web/src/components/ConfirmContext.tsx`), same toasts
  (`web/src/ToastContext.tsx`). Introduce zero new libraries.

## Read first

1. `server/src/routes/volumes.ts` and `server/src/services/volumes.ts` —
   inventory exactly which endpoints exist (list, inspect, create, remove,
   prune — verify, do not assume) and their response shapes.
2. `web/src/pages/Buckets.tsx` — the closest structural sibling (list +
   create + delete + detail) — this is your template.
3. `web/src/App.tsx` — routing and nav registration.
4. `web/src/types.ts`, `web/src/api.ts`, `web/src/format.ts`.
5. `server/src/usage.ts` — the Docker `system/df` call already returns
   per-volume size data; find how volumes appear there.

## Step-by-step instructions

### Step 1 — Server inventory and gap-fill

1. Enumerate the current volumes endpoints by reading the router. Then check
   each of the following exists; add any that are missing (in the existing
   service/route files, matching their code style):
   - `GET /api/volumes` — list, each entry with: name, driver, mountpoint,
     created, labels, and **which containers use it**. For usage, call
     `docker.listContainers({ all: true })` once and cross-reference each
     container's `Mounts` array by volume name; return
     `usedBy: Array<{ containerId, containerName, destination, rw }>`.
     Do NOT call `inspect` per container in a loop.
   - `GET /api/volumes/:name` — inspect one, same enrichment.
   - `POST /api/volumes` — create, body `{ name, driver?, labels? }`.
     Validate name against Docker's rules (`/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/`),
     reject otherwise with 400 and a message that states the rule.
   - `DELETE /api/volumes/:name?force=` — remove. When Docker refuses because
     the volume is in use (dockerode error statusCode 409), return 409 with
     `{ error: 'Volume is in use by: <container names>.' }` — resolve the
     names from the same cross-reference logic so the user is told exactly
     what blocks deletion.
   - `POST /api/volumes/prune` — remove dangling volumes; return
     `{ volumesDeleted: string[], spaceReclaimed: number }` passthrough from
     the engine response.
   - Size: per-volume size comes from the engine's `df` endpoint
     (`docker.df()`), field `Volumes[].UsageData.Size` (may be `-1` =
     unknown; pass through as `null`, and the UI shows `—`). Join sizes into
     the list response by name.
2. Volumes named like the system MinIO volume or labeled `iaas.system` must
   be flagged `system: true` in the response and REFUSED deletion server-side
   (403, `'System volumes are managed by Dockyard.'`). Find how containers
   with the `iaas.system` label are shielded (search `iaas.system` in
   `server/src`) and mirror the approach for volumes.

### Step 2 — The Volumes page

1. Create `web/src/pages/Volumes.tsx` modeled on `Buckets.tsx`:
   - Table: Name, Driver, Size (formatted via `format.ts` — `—` when null),
     Created (relative, reuse existing date helper), Used by (chips with
     container names, each linking to the instance detail route), badge for
     `system: true`.
   - Header actions: **Create volume** (inline form or small modal: name +
     optional labels; client-side validate the same name regex and surface
     the server's 400 message on mismatch), **Prune unused** (confirm dialog:
     "Remove all volumes not used by any container? This cannot be undone.",
     then toast the reclaimed space using the byte formatter).
   - Row action: **Remove** — confirm dialog naming the volume. When the
     server returns 409, show its message (which lists blocking containers)
     in the error toast verbatim. A `force` re-try option may be offered ONLY
     in the 409 error state, with a second, scarier confirm.
   - System volumes render no Remove action at all (server enforces anyway).
2. Register the route and nav entry in `web/src/App.tsx` next to Buckets
   (same ordering logic as the existing pages; icon from `web/src/icons.tsx`
   — pick an existing suitable icon, do not add an icon library).
3. Add the response types to `web/src/types.ts` and fetch helpers to
   `web/src/api.ts` following the exact existing helper style.
4. Empty state: a friendly panel ("No volumes yet") consistent with how
   Buckets/Instances render empty states — find and copy that pattern.
5. Refresh: after any mutation, re-fetch the list (see how Buckets does
   post-action refresh; the codebase has a `refresh.ts` — check whether pages
   subscribe to a global refresh tick and follow suit).

### Step 3 — Tests

1. Server: add/extend `server/src/routes/` tests (supertest against
   `createApp()`, existing pattern) for: name validation 400, system-volume
   deletion 403, in-use deletion 409 message shape. Mock the docker layer the
   way existing service tests do (read `server/src/db.test.ts` and
   `gatewayAudit.test.ts` for the local mocking idiom; if no docker-mocking
   precedent exists, extract the pure logic — name validation, usedBy
   cross-referencing from a containers array — into exported functions in
   the service and unit-test those directly with fixture arrays).
2. Ensure new routes appear in `server/src/routes/authCoverage.test.ts`'s
   enumeration if it has one.
3. Web: unit-test the name-validation helper and the usedBy-chip rendering
   logic if extracted; do not attempt full page render tests unless
   `web/test/` already demonstrates a component-test setup you can copy.

## Things you must NOT do

- No new npm packages, client or server.
- No volume *content browsing* (listing files inside a volume) — that is a
  different, security-sensitive feature; explicitly out of scope. Say so in
  the PR description under "Non-goals".
- Do not let the UI delete system volumes even with force.
- Do not restyle or refactor existing pages.

## Acceptance criteria

1. A Volumes nav entry exists; the page lists volumes with size, usage
   chips, and system badges.
2. Create, remove (with in-use 409 handling and forced retry), and prune all
   work end-to-end with confirm dialogs and toasts.
3. System volumes cannot be removed via API (403) or UI.
4. `npm run typecheck`, `npm test`, `npm run lint` pass.

## Verification

```bash
npm run typecheck && npm test && npm run lint
# With Docker running:
docker volume create gap03-test
npm run dev &
# In the browser: verify gap03-test appears, create/remove another volume,
# attach gap03-test to a container (docker run -v gap03-test:/x alpine sleep 300)
# and verify Remove yields the in-use message listing the container.
```

Describe the manual checks you performed in the PR description.

## Commit and push

Commits per step (`feat(gap-03): ...`), then
`git push -u origin gap/03-volume-ui`; PR title
`feat: volume management page`.
