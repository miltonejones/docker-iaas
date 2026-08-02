# Project Manifest & Resource Protection

Implement a declarative project manifest system with hard-block resource protection
for Dockyard projects.

## Context

Currently, projects are purely a grouping mechanism — they link resources via foreign
keys and a Docker label. Resources can be deleted at any time with no regard for
project membership. This feature adds two things:

1. **Declarative manifest** — a JSON snapshot of a project's resources and their
   configuration, stored on the project. Created by "capturing" currently linked
   resources. No desired-state reconciliation engine — capture-only.

2. **Hard-block protection** — resources referenced in any project's manifest
   cannot be deleted (or have their route targets changed) by non-admin users.
   The `admin` role bypasses all protection checks. This allows the Dockyard
   assistant (which uses the consumer JWT, inheriting the first user's role) to
   reconfigure resources freely.

## Design decisions (pre-confirmed)

- Manifest creation: **capture-only** (snapshot existing resources, no from-scratch definition)
- Protection level: **hard block** on delete + route target change; stop/start/restart allowed
- Assistant bypass: **admin role skips protection** (consumer JWT already carries first user's role)

## Manifest shape

```json
{
  "version": 1,
  "capturedAt": "2026-08-02T12:00:00Z",
  "containers": {
    "web": {
      "id": "abc123",
      "image": "nginx:alpine",
      "ports": [{ "container": "80", "host": 8080 }],
      "env": { "NODE_ENV": "production" }
    }
  },
  "routes": {
    "my-site": {
      "id": "rt-456",
      "targetType": "container",
      "targetRef": "web",
      "targetPort": 80,
      "domain": "example.com"
    }
  },
  "functions": {},
  "buckets": {},
  "databases": {}
}
```

Keys are logical `ref` names derived from the resource name. `targetRef` uses
logical names for portability across Docker IDs.

## Implementation steps

### 1. DB schema

Add `manifest` column to the `projects` table.

```sql
ALTER TABLE projects ADD COLUMN manifest TEXT;
```

File: `server/src/db.ts` — add column to the `CREATE TABLE IF NOT EXISTS projects`
statement and ensure it reads in `getProject` / `listProjects`.

### 2. Manifest API

Three new endpoints on `server/src/routes/projects.ts`:

**PUT /api/projects/:id/manifest** — Capture
- Reads all resources linked to the project (containers via Docker labels, functions/routes/buckets/databases via project_id columns)
- Builds the manifest JSON with logical refs
- Writes it to `projects.manifest`
- Requires `operator` role

**GET /api/projects/:id/manifest** — Read
- Returns the stored manifest JSON
- Returns 404 if no manifest captured yet

**GET /api/projects/:id/manifest/drift** — Drift detection
- Compares manifest vs live state
- Returns: `{ synced: [...], missing: [...], changed: [...], orphaned: [...] }`
  - `missing`: in manifest but resource no longer exists
  - `changed`: exists but config differs (image, ports, env, target, etc.)
  - `orphaned`: linked to project but NOT in manifest (added after last capture)

Service logic goes in `server/src/services/projects.ts`:
- `captureManifest(projectId, userId)` — builds and stores manifest
- `getManifest(projectId, userId)` — reads stored manifest
- `getManifestDrift(projectId, userId)` — compares vs live state
- `isResourceProtected(resourceType, resourceId)` — checks ALL project manifests,
  returns `{ protected: boolean, projectName?: string }`

### 3. Protection enforcement

In every resource delete handler, and the route target-update handler, add a
protection check before the destructive action:

```ts
const protection = projectService.isResourceProtected('<type>', id);
if (protection.protected && req.authUser?.role !== 'admin') {
  res.status(409).json({
    error: `<Resource type> is managed by project "${protection.projectName}". Unlink it from the project first.`
  });
  return;
}
```

Files to modify (protection check in each DELETE handler):

| File | Resources | Also block |
|---|---|---|
| `server/src/routes/containers.ts` | containers | — |
| `server/src/routes/gateway.ts` | routes | route target change (PUT/PATCH that changes targetId) |
| `server/src/routes/lambda.ts` | functions | — |
| `server/src/routes/buckets.ts` | buckets | — |
| `server/src/routes/databases.ts` | database connections | — |

`isResourceProtected` implementation:
- Query: `SELECT p.id, p.name, p.manifest FROM projects WHERE manifest IS NOT NULL`
- For each project, parse `manifest` JSON
- Check if the resource type+id appears in any container's `id`, route's `id`, function's `functionId`, bucket's `name`, or database's `connectionId`
- Return first match (or `{ protected: false }`)

### 4. Unlink sync

When a resource is unlinked from a project (via `unlinkResource` in
`server/src/services/projects.ts`), also strip it from the project's manifest:

- If the unlinked resource is a container, remove its ref from `manifest.containers`
- Same for functions, routes, buckets, databases
- Save the updated manifest

This keeps the manifest in sync when resources leave the project.

### 5. Web UI

**ProjectDetail page** (`web/src/pages/ProjectDetail.tsx`):

- Add **"Capture"** button in the project header — calls `PUT /api/projects/:id/manifest`
- After capture, show drift indicators next to each resource:
  - 🟢 synced: resource matches manifest
  - 🟡 changed: config differs
  - 🔴 missing: in manifest but doesn't exist
  - ⚪ orphaned: linked but not in manifest
- Add a **"Manifest"** tab/section showing the JSON (read-only, with a download button)
- **Disable delete buttons** for protected resources when user is not admin:
  - Button appears greyed out
  - Tooltip: "Managed by project <name>"
  - `api.ts` callers can check the 409 response and show a toast

**ProjectSelector** (`web/src/components/ProjectSelector.tsx`): no changes needed.

**ContainerPanel / other resource panels**: delete buttons should handle the 409
response gracefully — show a toast with the error message rather than a generic
"delete failed".

### 6. API client

`web/src/api.ts` already has `projectList`, `projectGet`, etc. Add:

```ts
projectGetManifest: (id: string) =>
  fetch(`/api/projects/${encodeURIComponent(id)}/manifest`).then(r => json(r)),

projectCaptureManifest: (id: string) =>
  fetch(`/api/projects/${encodeURIComponent(id)}/manifest`, { method: 'PUT' }).then(r => json(r)),

projectGetManifestDrift: (id: string) =>
  fetch(`/api/projects/${encodeURIComponent(id)}/manifest/drift`).then(r => json(r)),
```

## TypeScript types

New types in `web/src/types.ts`:

```ts
interface ProjectManifestResource {
  id: string;
  image?: string;
  ports?: { container: string; host: number }[];
  env?: Record<string, string>;
  volumes?: string[];
  description?: string;
  targetType?: 'container' | 'bucket' | 'lambda';
  targetRef?: string;
  targetPort?: number;
  method?: string;
  pathPattern?: string;
  domain?: string;
  runtime?: string;
  engine?: string;
}

interface ProjectManifest {
  version: number;
  capturedAt: string;
  containers: Record<string, ProjectManifestResource>;
  routes: Record<string, ProjectManifestResource>;
  functions: Record<string, ProjectManifestResource>;
  buckets: Record<string, ProjectManifestResource>;
  databases: Record<string, ProjectManifestResource>;
}

interface ManifestDrift {
  synced: string[];
  missing: Array<{ ref: string; kind: string }>;
  changed: Array<{ ref: string; kind: string; diff: Record<string, unknown> }>;
  orphaned: Array<{ ref: string; kind: string; id: string }>;
}
```

## Files summary

| File | Change |
|---|---|
| `server/src/db.ts` | Add `manifest` column to projects table |
| `server/src/services/projects.ts` | Add `captureManifest`, `getManifest`, `getManifestDrift`, `isResourceProtected` |
| `server/src/routes/projects.ts` | Add `PUT /:id/manifest`, `GET /:id/manifest`, `GET /:id/manifest/drift` |
| `server/src/routes/containers.ts` | Protection check in DELETE handler |
| `server/src/routes/gateway.ts` | Protection check in DELETE + target update handlers |
| `server/src/routes/lambda.ts` | Protection check in DELETE handler |
| `server/src/routes/buckets.ts` | Protection check in DELETE handler |
| `server/src/routes/databases.ts` | Protection check in DELETE handler |
| `web/src/types.ts` | Add `ProjectManifest`, `ManifestDrift` types |
| `web/src/api.ts` | Add `projectGetManifest`, `projectCaptureManifest`, `projectGetManifestDrift` |
| `web/src/pages/ProjectDetail.tsx` | Capture button, drift indicators, disabled delete for protected resources |

## Constraints

- Do NOT create a reconciliation/auto-create engine. Manifest is read-only
  (capture to update, no "apply manifest" that creates resources).
- Do NOT modify the consumer (`scripts/issue-consumer.mjs`), `Dockerfile.consumer`,
  `docker-compose.yml`, or `.gitignore`. These are protected files.
- Do NOT add a new auth role or header. Use existing `admin` role for bypass.
- Match existing code style — TypeScript ESM, Express route patterns, React
  functional components.
- Add tests for new service functions in `server/src/services/projects.test.ts`
  (create if it doesn't exist).
- Run `npm run typecheck` and `npm run lint` after changes.
