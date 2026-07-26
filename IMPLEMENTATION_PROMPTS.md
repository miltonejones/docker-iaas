# Service Layer Extraction + MCP Server — Implementation Prompts

This file contains step-by-step prompts for implementing a service layer extraction and MCP server for Dockyard. Each prompt is self-contained and detailed enough for an LLM to execute without further context. Do them in order.

---

## Prompt 1: Create HttpError and shared types

Create two new files that other service modules will depend on.

### 1a. `server/src/services/HttpError.ts`

```typescript
/**
 * Standard error class for service-layer validation and business-logic errors.
 * Services throw this; route handlers catch it and map to HTTP status codes.
 * This replaces the HttpError previously defined in databaseManagement.ts.
 */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}
```

### 1b. `server/src/services/types.ts`

Create this file with ALL of the following type definitions. These are extracted from inline interfaces currently scattered across route files. Each type must be exported.

**Container types** (from `routes/containers.ts`):
- `ContainerView` — id, name, image, state, status, created, ports (array of {privatePort, publicPort?, type}), sizeRw, sizeRootFs, presetId?, projectId?, system?, protected?, description?
- `LaunchInput` — presetId?, image?, name?, description?, protected?, projectId?, command? (string[]), ports? (array of {container: string, host: number}), env? (array of {key, value}), volumes? (string[]), autoStart? (boolean, default true), assistantManaged? (boolean)
- `EnvUpdateInput` — env? (array of {key, value}), persist? (boolean), description?, protected?, projectId? (string | null to clear)
- `ExecInput` — command (string[]), workingDir?, background? (boolean), timeoutSeconds? (number, 1-600)
- `ExecResult` — command (string[]), workingDir (string | null), exitCode (number | null), output (string), truncated (boolean)
- `BackgroundExecResult` — execId (string), command (string[]), workingDir (string | null)
- `ProbeResult` — statusCode (number), headers (Record<string, string | string[] | undefined>), body (string), truncated (boolean)
- `FileInfo` — type ("directory" | "file"), name (string), size (number), mtime (number)
- `WriteFileInput` — path (string), content (string)
- `ReplaceInput` — path (string), search (string), replace (string)
- `ReplaceResult` — replacements (number), content (string)

**Bucket types** (from `routes/buckets.ts`):
- `BucketView` — name (string | undefined), creationDate (Date | undefined), size (number), objectCount (number), protected (boolean), projectId (string | null)
- `ObjectList` — prefixes (array of string | undefined), objects (array of {key: string | undefined, size: number, lastModified: Date | undefined})
- `WriteObjectInput` — key (string), content (string), contentType? (string)

**Gateway types** (from `routes/gateway.ts`):
- `CreateRouteInput` — name (string), displayName?, targetType (string), targetId (string), targetPort? (number), method? (string), pathPattern? (string), projectId? (string)
- `UpdateRouteInput` — displayName?, method?, pathPattern? (string | null to clear)

**Project types** (from `routes/projects.ts`):
- `CreateProjectInput` — name (string), description? (string)
- `UpdateProjectInput` — name?, description? (string | null to clear)

**Lambda types** (from `routes/lambda.ts`):
- `CreateFunctionInput` — name (string), runtime? (string), code? (string), packages? (string[]), entryPoint? (string), files? (array of {path, content}), description? (string), projectId? (string)
- `UpdateFunctionInput` — name?, runtime?, code?, packages?, entryPoint?, files? (array of {path, content}), description? (string | null to clear)

### 1c. Update `databaseManagement.ts`

Change the `HttpError` class definition in `server/src/databaseManagement.ts` to re-export from the new location:

Replace the class definition with:
```typescript
export { HttpError } from './services/HttpError.js';
```

This keeps backward compatibility — everything that imports `HttpError` from `databaseManagement.ts` still works.

### Verification

- Run `npx tsc --noEmit` in the `server` workspace. It should pass.
- No runtime changes yet — we're just creating shared types and moving the error class.

---

## Prompt 2: Extract system service

Create `server/src/services/system.ts` and thin out `server/src/routes/system.ts`.

### What the service module must contain

Read `server/src/routes/system.ts` first. Extract ALL business logic from its route handlers into the service module. The service must export these async functions:

- `ping(): Promise<{ok: boolean, version?: string, error?: string}>` — delegates to `pingDocker()` from `../docker.js`
- `presets(): unknown` — returns the `PRESETS` array from `../presets.js`
- `usage(): Promise<unknown>` — delegates to `getUsageSnapshot()` from `../usage.js`
- `buildCache(): Promise<unknown>` — the raw Docker modem call from the `/build-cache` route
- `pruneBuildCache(): Promise<{ok: boolean, cachesDeleted?: number, spaceReclaimed?: number}>` — the prune logic
- `usedPorts(): Promise<{ports: number[]}>` — scans running containers for published ports
- `audit(limit?: number): unknown[]` — delegates to `listAuditLogs()` from `../db/audit.js`

**Important**: The SSE endpoints (`/usage/stream`, `/ping` for unauthenticated ping) stay in the route file. Only the non-SSE business logic moves to the service.

### How to thin the route

After extraction, each route handler should look like:
```typescript
systemRouter.get('/ping', requireAuth, async (_req, res) => {
  try {
    res.json(await systemService.ping());
  } catch (err) {
    sendError(res, err);
  }
});
```

Add a `sendError` helper at the top of the route file:
```typescript
import { HttpError } from '../services/HttpError.js';

function sendError(res: Response, err: unknown): void {
  const status = err instanceof HttpError ? err.status : 502;
  res.status(status).json({ error: err instanceof Error ? err.message : 'Unknown error.' });
}
```

The service module must have ZERO Express imports. Verify with: `grep "from 'express'" server/src/services/system.ts` — must return nothing.

### Verification

- `npx tsc --noEmit` passes
- Start the dev server and verify `/api/system/ping`, `/api/system/presets`, `/api/system/usage` still work

---

## Prompt 3: Extract images, projects, volumes, auth, notifications services

Repeat the same pattern as Prompt 2 for these five simple route files. For each one:

1. Read the route file
2. Create `server/src/services/<name>.ts` with all business logic extracted
3. Thin out the route handler to just extract params, call service, send response
4. Add `sendError` helper if not already present

### `server/src/services/images.ts`
- Read `server/src/routes/images.ts`
- Extract: `list()`, `remove(id, force?)`, `prune()`
- All delegate to `docker` from `../docker.js`

### `server/src/services/projects.ts`
- Read `server/src/routes/projects.ts`
- Extract: `list(userId?)`, `get(id, userId?)`, `create(userId, input)`, `update(id, userId, input)`, `remove(id, userId?)`, `linkResource(projectId, userId, resourceTable, resourceId)`, `unlinkResource(projectId, userId, resourceTable, resourceId)`
- Delegates to `getProject`, `listProjects`, etc. from `../db.js`
- The `setContainerLabel()` helper (which calls docker) moves to this service

### `server/src/services/volumes.ts`
- Read `server/src/routes/volumes.ts`
- Extract: `list()`
- Single function, delegates to `docker.listVolumes()`

### `server/src/services/auth.ts`
- Read `server/src/routes/auth.ts`
- Extract: `register(email, password)`, `login(email, password)`, `getSettings(userId)`, `updateSettings(userId, settings)`
- Imports from `../db.js` (getUserByEmail, createUser, etc.) and `../auth.js` (signToken)
- The consumer API key exchange logic (`/consumer` route) also moves to this service

### `server/src/services/notifications.ts`
- Read `server/src/routes/notifications.ts`
- Extract: `list()`, `clear()`, `post(entry)`
- Delegates to `../db.js` notification functions

### Verification

- `npx tsc --noEmit` passes
- `grep -r "from 'express'" server/src/services/` returns nothing
- Start the dev server and spot-check a few endpoints from each service

---

## Prompt 4: Extract lambda, host-files, host-builds, databases services

These are medium complexity. The key difference: several of these already have exported helper functions that other modules import.

### `server/src/services/lambda.ts`
- Read `server/src/routes/lambda.ts`
- This file already exports `runLambda`, `entryPathOf`, `fullFileSet`, `stripLogHeaders` — these move to the service module, and the route file re-exports them from the service for backward compatibility
- Extract service functions: `list(userId?, projectId?)`, `get(id, userId?)`, `create(userId?, input)`, `update(id, userId?, input)`, `remove(id)`, `run(...)`, `listRuntimes()`, `history()`, `getEnv(functionId, userId?)`, `setEnv(functionId, userId?, env)`
- The `RUNTIMES` constant and its helper functions move to the service
- The `backgroundEphemeralContainers` Map moves to the service (it's module-scoped state)

### `server/src/services/host-files.ts`
- Read `server/src/routes/hostFiles.ts`
- This file already exports `resolveHostPath`, `listHostDirectory`, `readHostTextFile`, `isSensitiveAssistantPath`, `validContainerPath` — move these to the service, re-export from the route for backward compat
- Extract service functions: `copyToBucket(sourcePath, bucket, key, contentType?)`, `copyToContainer(sourcePath, containerId, destinationPath)`, `listDirectory(sourcePath)`, `readTextFile(sourcePath)`

### `server/src/services/host-builds.ts`
- Read `server/src/routes/hostBuilds.ts`
- This file already exports `listHostBuildPresets` — move to service, re-export
- Extract: `listPresets()`, `run(preset, containerId, destinationPath)`

### `server/src/services/databases.ts`
- Read `server/src/routes/databases.ts` and `server/src/databaseManagement.ts`
- `databaseManagement.ts` is already a proper service module — it stays as-is
- The new `databases.ts` service is a thin orchestration layer that:
  - Delegates to functions from `databaseManagement.ts`
  - Adds audit logging for mutations
  - Handles the `confirmed` flag flow (preview vs. execute)
- Extract: `listConnections(userId?, projectId?)`, `getConnection(id, userId?)`, `createConnection(userId?, input, projectId?)`, `updateConnection(id, input)`, `deleteConnection(id)`, `testConnection(id)`, `inspectSchema(id, database?)`, `runRead(id, body)`, `previewMutation(id, body)`, `executeMutation(id, body, userId?)`, `previewGrant(id, body)`, `executeGrant(id, body, userId?)`, `createBackup(connectionId, input, userId?)`, `restoreBackup(connectionId, input, userId?)`, `listOperations()`, `listJobs()`, `getJob(id)`, `getJobArtifactDownload(jobId)`
- The route's `statusForError` / `sendError` pattern already uses `HttpError` — keep this

### Verification

- `npx tsc --noEmit` passes
- `grep -r "from 'express'" server/src/services/` returns nothing
- Verify that the assistant's `executeReadOnlyTool()` still works (it imports `runLambda` and other functions from the route files, which re-export from the service)
- Start the dev server and test lambda creation, file copy, and database query

---

## Prompt 5: Extract buckets service

This is the first complex extraction involving S3 operations.

### `server/src/services/buckets.ts`
- Read `server/src/routes/buckets.ts`
- Extract all business logic into service functions:
  - `list(userId?): Promise<BucketView[]>` — MUST include user-ownership filtering (call `listUserBuckets(userId)`) AND `bucketStats()` for size/objectCount. This is currently missing from the assistant's version.
  - `get(name): Promise<BucketView>` — single bucket metadata with stats
  - `create(userId?, name, protect?): Promise<{name, protected}>` — creates bucket, sets owner via `setBucketOwner()`
  - `remove(name, userId?): Promise<void>` — validates ownership, deletes bucket
  - `setProtected(name, userId?, protect): Promise<void>`
  - `listObjects(name, prefix?): Promise<ObjectList>` — lists objects with prefix filtering
  - `getObject(name, key): Promise<{body: Buffer, contentType: string}>` — get object content and type
  - `putObject(name, key, body: Buffer, contentType?): Promise<void>` — upload object
  - `deleteObject(name, key): Promise<void>` — delete object
  - `replaceInObject(name, key, search, replace): Promise<ReplaceResult>` — search-and-replace in object
  - `writeObjects(name, objects: WriteObjectInput[]): Promise<{ok: true, objectsWritten: number}>` — bulk write
  - `copyHostFileToBucket(sourcePath, bucket, key, contentType?): Promise<{bucket, key, size}>` — reads host file, uploads to bucket
- The `bucketStats()` helper function (which iterates all objects to compute size/count) moves to the service
- S3 operations use `getS3Client()` from `../minio.js` and `@aws-sdk/client-s3` commands
- Ownership functions use `setBucketOwner`, `getBucketOwner`, `listUserBuckets`, `isBucketProtected`, `setBucketProtected` from `../db.js`

### Route thinning
- The raw-body PUT endpoint (`express.raw({ type: '*/*' })`) stays in the route — it reads `req.body` as a Buffer and calls `bucketService.putObject()`
- All JSON endpoints become thin callers

### Verification

- `npx tsc --noEmit` passes
- Test bucket creation, listing (with stats), object upload/download in the browser

---

## Prompt 6: Extract gateway service

This is complex because it includes DNS/Route53 and Caddy management alongside route CRUD.

### `server/src/services/gateway.ts`
- Read `server/src/routes/gateway.ts`
- Extract:
  - `list(userId?, projectId?): GatewayRouteView[]` — calls `listRoutes(userId, projectId)` from `../db/gateway.js`
  - `createRoute(userId?, input: CreateRouteInput): Promise<GatewayRouteView>` — validates name regex (`NAME_RE`), targetType, targetPort requirement for containers, checks for duplicates (same name + method + pathPattern = 409), creates via `createRoute()` from db, records audit
  - `updateRoute(id, userId?, input: UpdateRouteInput): GatewayRouteView`
  - `deleteRoute(id, userId?): Promise<void>` — deletes route, removes Caddy config if needed, records audit
  - `setDomain(id, userId?, domain): GatewayRouteView` — stores domain on route, records audit
  - `enableDomain(id, userId?): Promise<...>` — Route53 preflight, CNAME creation, Caddy config, TLS provisioning via `../caddy.js` and `../route53.js`
  - `checkDomainStatus(id): DomainStatus`
  - `removeDomain(id, userId?): Promise<void>` — Caddy teardown, DNS cleanup
  - `trafficSummary(filters): TrafficSummaryResult`
  - `trafficRequests(filters, limit): TrafficRequestResult`
  - `trafficTimeseries(windowHours): TrafficTimeseriesResult`
  - `listDnsZones(): Promise<DnsZonesResult>` — delegates to `../route53.js`
  - `listDnsRecords(zoneId, name?): Promise<DnsRecordsResult>`
  - `createDnsRecord(zoneId, name): Promise<DnsRecordResult>`
  - `deleteDnsRecord(zoneId, name): Promise<void>`
- The `NAME_RE` regex, `TARGET_TYPES`, `VALID_METHODS` constants move to the service
- The `GatewayApiError` class becomes `HttpError` — replace `throw new GatewayApiError(status, message)` with `throw new HttpError(status, message)`
- Caddy functions from `../caddy.js` and Route53 functions from `../route53.js` are called by the service

### What stays in the route
- The Playwright screenshot endpoint (`GET /preview/:name`) — it manages HTTP response and browser lifecycle
- SSE streaming for traffic data (if any)
- The `sendError` helper (using the service's `HttpError`)

### Verification

- `npx tsc --noEmit` passes
- Test gateway route creation, listing, and deletion

---

## Prompt 7: Extract containers service

This is the largest and most complex extraction (~1016 lines of route code).

### `server/src/services/containers.ts`
- Read `server/src/routes/containers.ts` carefully — it's the biggest file
- Extract ALL business logic. The service must export:
  - `list(userId?, projectId?): Promise<ContainerView[]>` — MUST apply user-ownership filtering, ephemeral container filtering (`iaas.ephemeral` label), project filtering, and include size data (`size: true`). This fixes the assistant's divergence.
  - `launch(userId?, input: LaunchInput): Promise<{id: string}>` — validates preset, pulls image via `ensureImage()`, creates volumes, sets labels including `iaas.owner`, `iaas.preset`, `iaas.assistant-managed`, `iaas.description`, `iaas.protected`, `iaas.project_id`, attaches to `dockyard-net`, auto-starts, records audit
  - `start(id, userId?): Promise<void>` — checks ownership and `iaas.system` label
  - `stop(id, userId?): Promise<void>`
  - `restart(id, userId?): Promise<void>`
  - `remove(id, userId?, force?): Promise<void>` — checks ownership and `iaas.protected` label
  - `inspect(id): Promise<ContainerInspectResult>`
  - `logs(id, tail?): Promise<string>`
  - `updateEnv(id, userId?, input: EnvUpdateInput): Promise<EnvUpdateResult>` — reconstructs container with updated env, records audit
  - `exec(id, userId?, input: ExecInput): Promise<ExecResult | BackgroundExecResult>` — validates command (1-32 strings, max 4096 chars each), checks `iaas.assistant-managed` label, checks container running, executes, truncates output at 256KB
  - `getExecOutput(execId): BackgroundExecOutput | null`
  - `writeFile(id, userId?, input: WriteFileInput): Promise<{ok: true, path: string}>`
  - `writeFiles(id, userId?, files: WriteFileInput[]): Promise<{ok: true, filesWritten: number}>`
  - `replaceInFile(id, userId?, input: ReplaceInput): Promise<ReplaceResult>`
  - `listFiles(containerId, dirPath?, maxDepth?): Promise<ListFilesResult>` — reuses existing `listContainerFiles` logic
  - `probeEndpoint(containerId, port, path?, method?): Promise<ProbeResult>` — reuses existing `probeContainerEndpoint` logic
- The `backgroundExecOutputs` Map (module-scoped state) moves to the service
- The `toView()` helper moves to the service
- The `lifecycle()` helper (start/stop/restart dispatch) moves to the service
- `stripLogHeaders()` moves to the service
- Auth checks for `iaas.system`, `iaas.protected`, `iaas.assistant-managed` labels are done inside service methods, throwing `HttpError(403, ...)` or `HttpError(409, ...)` as appropriate
- Audit logging via `recordAuditLog()` happens inside service methods for all mutations

### What stays in the route
- SSE streaming endpoint (`POST /:id/exec/stream`) — it manages Server-Sent Events response
- The `express.raw()` body parsing for file write endpoints (stays as middleware)
- Route-specific request validation like checking `req.body` shape (though deeper validation moves to service)

### Verification

- `npx tsc --noEmit` passes
- `grep -r "from 'express'" server/src/services/containers.ts` returns nothing
- Start dev server, test container launch, listing (with ownership filtering), start/stop, exec, file write, logs

---

## Prompt 8: Create the MCP server workspace

Now that all services are extracted, create the MCP server package.

### 8a. Create `mcp/package.json`

```json
{
  "name": "dockyard-mcp",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.1"
  },
  "devDependencies": {
    "tsx": "^4.16.2",
    "typescript": "^5.5.3"
  }
}
```

Note: The MCP server does NOT list `dockyard-server` as a dependency. Instead, it uses TypeScript path resolution through the monorepo workspace to import from `../../server/src/services/*.js`. This works because npm workspaces hoist and link packages, and `tsx` resolves TypeScript source files across workspace boundaries.

### 8b. Create `mcp/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true,
    "declaration": false,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"]
}
```

### 8c. Update root `package.json`

Add `"mcp"` to the `workspaces` array:
```json
"workspaces": ["server", "web", "relay", "mcp"]
```

Add workspace scripts:
```json
"dev:mcp": "npm --workspace mcp run dev",
"typecheck": "... existing ... && npm --workspace mcp run typecheck"
```

### 8d. Run `npm install` from the project root to install the MCP SDK and link workspaces.

### Verification

- `npm --workspace mcp run typecheck` passes (there are no source files yet, so it should be a no-op)
- `ls node_modules/@modelcontextprotocol/sdk` exists

---

## Prompt 9: Create MCP auth and entry point

### 9a. Create `mcp/src/auth.ts`

This module resolves a userId from environment variables. It must initialize the same way as the main server (load JWT secret, init DB) so it can verify tokens.

```typescript
import jwt from 'jsonwebtoken';
import { getUserById } from '../../server/src/db.js';

let jwtSecret: string | null = null;

export async function initAuth(): Promise<void> {
  // Load JWT secret the same way as server/src/auth.ts
  // Read from DOCKYARD_JWT_SECRET env var or generate/store in DB
  jwtSecret = await loadJwtSecret(); // import from server/src/auth.js
}

export function resolveUserId(): string | undefined {
  // Priority 1: DOCKYARD_JWT — a pre-obtained JWT token
  const jwtToken = process.env.DOCKYARD_JWT;
  if (jwtToken) {
    try {
      const payload = jwt.verify(jwtToken, jwtSecret!) as { userId: string };
      const user = getUserById(payload.userId);
      return user?.id;
    } catch {
      return undefined;
    }
  }

  // Priority 2: DOCKYARD_API_KEY — validate against CONSUMER_API_KEY
  const apiKey = process.env.DOCKYARD_API_KEY;
  if (apiKey) {
    if (apiKey !== process.env.CONSUMER_API_KEY) return undefined;
    // Return the first user in the system
    // This mirrors the /api/auth/consumer endpoint behavior
    const users = listAllUsers(); // import from server/src/db.js
    return users[0]?.id;
  }

  // No auth configured — return undefined (operations will work but skip user scoping)
  return undefined;
}
```

Read `server/src/auth.ts` and `server/src/db.ts` to understand how JWT secret loading and user lookup work, then implement `initAuth()` and `resolveUserId()` to match.

### 9b. Create `mcp/src/index.ts`

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS } from './tools.js';
import { handleCallTool } from './handlers.js';
import { initAuth } from './auth.js';
import { initDb } from '../../server/src/db.js';
import { ensureNetwork } from '../../server/src/docker.js';
import { ensureMinio } from '../../server/src/minio.js';

async function main() {
  // Initialize the same dependencies as the main server
  initDb();
  await ensureNetwork();
  await ensureMinio();
  await initAuth();

  const server = new Server(
    { name: 'dockyard', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOL_DEFINITIONS }));
  server.setRequestHandler(CallToolRequestSchema, handleCallTool);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Dockyard MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

**Important**: Use `console.error()` for logging, NOT `console.log()`. The MCP server communicates over stdout — any `console.log()` output would corrupt the protocol. All diagnostic output goes to stderr.

### Verification

- `npm --workspace mcp run typecheck` passes
- The entry point compiles without errors

---

## Prompt 10: Create MCP tool definitions

Create `mcp/src/tools.ts` with ALL tool definitions in MCP format.

This is the largest file. It adapts the ~55 tool schemas from `server/src/routes/assistant.ts` (the `tools` array) to MCP's JSON Schema format. Read the `tools` array in `assistant.ts` carefully, including the database tools in `databaseAssistantTools.ts` and GitHub tools in `githubAssistantTools.ts`.

### Key differences from assistant schemas to MCP format:

1. **Key name**: `input_schema` → keep as `inputSchema` (MCP v1 SDK uses `inputSchema` in the `Tool` type)
2. **Add missing parameters** that the assistant schemas omit:
   - `launch_container`: add `projectId` (string, optional), `volumes` (array of strings, optional), `autoStart` (boolean, default true)
   - `list_containers`: add `projectId` (string, optional)
   - `list_functions`: add `projectId` (string, optional)
   - `list_gateway_routes`: add `projectId` (string, optional)
   - `list_buckets`: add `projectId` (string, optional)
3. **Don't include** assistant-specific tools: `wait`, `report_issue`, `update_issue`, `delete_issue`, `clear_issues`, `get_consumer_status`, `get_consumer_activity`, `check_consumer_health` — these are internal to the AI assistant loop
4. **Don't include** session management tools — those are assistant-specific

### Tool categories to include:

**Containers (14)**: list_containers, launch_container, inspect_container, container_action, delete_container, get_container_logs, update_container_env, execute_container_command, get_container_exec_output, write_container_file, write_container_files, replace_in_container_file, list_container_files, probe_container_endpoint

**Buckets (10)**: list_buckets, create_bucket, delete_bucket, update_bucket, list_bucket_objects, read_bucket_object, write_bucket_object, write_bucket_objects, delete_bucket_object, replace_in_bucket_object

**Gateway (6)**: list_gateway_routes, create_gateway_route, update_gateway_route, delete_gateway_route, manage_gateway_domain, manage_dns_records

**Lambda (6)**: list_functions, read_function, create_lambda_function, update_lambda_function, delete_lambda_function, run_function (or keep the name from assistant.ts)

**Images (3)**: list_images, delete_image, prune_images

**System (4)**: system_ping, list_presets, list_used_ports, prune_build_cache

**Host (4)**: list_host_directory, read_host_file, copy_host_file_to_container, copy_host_file_to_bucket

**Host builds (2)**: list_host_build_presets, run_host_build_preset

**Databases (12)**: list_database_connections, get_database_connection, get_database_operations_overview, inspect_database_schema, run_database_read_query, test_database_connection, create_database_connection, update_database_connection, delete_database_connection, execute_database_mutation, execute_database_migration, execute_database_access_grant, create_database_backup, restore_database_backup, list_database_jobs, get_database_job

**GitHub (4)**: list_github_repo_files, read_github_file, pull_github_repo_to_bucket, pull_github_repo_to_container, commit_and_push_github_files

**Projects (3)**: list_projects, create_project, update_project, delete_project

**Volumes (1)**: list_volumes

### Format for each tool definition:

```typescript
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'list_containers',
    description: 'List all Docker containers. Optionally filter by project.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectId: {
          type: 'string',
          description: 'Filter containers by project ID',
        },
      },
    },
  },
  {
    name: 'launch_container',
    description: 'Launch a new Docker container from a preset or image.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        presetId: { type: 'string', description: 'Preset ID to use' },
        image: { type: 'string', description: 'Docker image to use' },
        name: { type: 'string', description: 'Container name' },
        description: { type: 'string', description: 'Human-readable description' },
        protected: { type: 'boolean', description: 'Prevent accidental deletion' },
        projectId: { type: 'string', description: 'Project to associate this container with' },
        command: { type: 'array', items: { type: 'string' }, description: 'Command to run' },
        ports: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              container: { type: 'string' },
              host: { type: 'number' },
            },
            required: ['container', 'host'],
          },
          description: 'Port mappings',
        },
        env: {
          type: 'array',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, value: { type: 'string' } },
            required: ['key', 'value'],
          },
          description: 'Environment variables',
        },
        volumes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Volume mounts (e.g. "mydata:/app/data")',
        },
        autoStart: {
          type: 'boolean',
          description: 'Start the container after creation (default: true)',
        },
      },
    },
  },
  // ... all other tools
];
```

Write the complete file with ALL tool definitions. This will be a large file (~500-600 lines) but it's mechanical — each tool is just a name, description, and inputSchema.

### Verification

- `npm --workspace mcp run typecheck` passes
- The tool list covers all the categories above

---

## Prompt 11: Create MCP handler dispatch

Create `mcp/src/handlers.ts` that imports all service modules and dispatches tool calls.

### Pattern

```typescript
import { containerService } from '../../server/src/services/containers.js';
import { bucketService } from '../../server/src/services/buckets.js';
import { gatewayService } from '../../server/src/services/gateway.js';
import { lambdaService } from '../../server/src/services/lambda.js';
import { imageService } from '../../server/src/services/images.js';
import { systemService } from '../../server/src/services/system.js';
import { projectService } from '../../server/src/services/projects.js';
import { databaseService } from '../../server/src/services/databases.js';
import { hostFileService } from '../../server/src/services/host-files.js';
import { hostBuildService } from '../../server/src/services/host-builds.js';
import { volumeService } from '../../server/src/services/volumes.js';
import { authService } from '../../server/src/services/auth.js';
import { resolveUserId } from './auth.js';

type CallToolRequest = { params: { name: string; arguments?: Record<string, unknown> } };

export async function handleCallTool(request: CallToolRequest): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  const { name, arguments: args = {} } = request.params;
  const userId = resolveUserId();

  try {
    let result: unknown;

    switch (name) {
      // Containers
      case 'list_containers':
        result = await containerService.list(userId, args.projectId as string | undefined);
        break;
      case 'launch_container':
        result = await containerService.launch(userId, args as any);
        break;
      case 'inspect_container':
        result = await containerService.inspect(args.id as string);
        break;
      case 'container_action':
        if (args.action === 'start') result = await containerService.start(args.id as string, userId);
        else if (args.action === 'stop') result = await containerService.stop(args.id as string, userId);
        else if (args.action === 'restart') result = await containerService.restart(args.id as string, userId);
        else throw new Error(`Unknown container action: ${args.action}`);
        break;
      case 'delete_container':
        result = await containerService.remove(args.id as string, userId, args.force as boolean);
        break;
      case 'get_container_logs':
        result = await containerService.logs(args.id as string, args.tail as number | undefined);
        break;
      case 'update_container_env':
        result = await containerService.updateEnv(args.id as string, userId, args as any);
        break;
      case 'execute_container_command':
        result = await containerService.exec(args.id as string, userId, args as any);
        break;
      case 'get_container_exec_output':
        result = containerService.getExecOutput(args.execId as string);
        break;
      case 'write_container_file':
        result = await containerService.writeFile(args.id as string, userId, args as any);
        break;
      case 'write_container_files':
        result = await containerService.writeFiles(args.id as string, userId, args.files as any[]);
        break;
      case 'replace_in_container_file':
        result = await containerService.replaceInFile(args.id as string, userId, args as any);
        break;
      case 'list_container_files':
        result = await containerService.listFiles(args.id as string, args.path as string | undefined, args.maxDepth as number | undefined);
        break;
      case 'probe_container_endpoint':
        result = await containerService.probeEndpoint(args.id as string, args.port as number, args.path as string | undefined, args.method as string | undefined);
        break;

      // Buckets
      case 'list_buckets':
        result = await bucketService.list(userId, args.projectId as string | undefined);
        break;
      case 'create_bucket':
        result = await bucketService.create(userId, args.name as string, args.protected as boolean | undefined);
        break;
      // ... continue for all tools ...

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
      isError: true,
    };
  }
}
```

Write the COMPLETE file with ALL tool cases. Each case is 1-3 lines. This will be a large file but it's entirely mechanical.

### For database tools specifically

The database tools delegate to `databaseManagement.ts` functions which already follow the service pattern. The handler calls them directly:

```typescript
case 'run_database_read_query':
  result = await runSavedConnectionRead(String(args.connectionId ?? ''), args);
  break;
```

### For GitHub tools

Import the existing functions from `server/src/githubAssistantTools.ts`:

```typescript
case 'pull_github_repo_to_bucket':
  result = await pullGithubRepoToBucket(args as any);
  break;
```

### Verification

- `npm --workspace mcp run typecheck` passes
- The switch statement covers every tool name defined in `tools.ts`

---

## Prompt 12: Refactor assistant's executeReadOnlyTool

Now that all service modules exist, refactor `server/src/routes/assistant.ts`.

### What to change

Find the `executeReadOnlyTool` function (around line 1187). It currently has a large `switch` statement where each case calls Docker/S3/DB directly. Replace each case with a call to the corresponding service method.

**Before:**
```typescript
case "list_containers": {
  const list = await docker.listContainers({ all: true });
  return list.map((c) => ({
    id: c.Id,
    name: (c.Names?.[0] || "").replace(/^\//, ""),
    image: c.Image,
    state: c.State,
    description: c.Labels?.["iaas.description"] || undefined,
    protected: !!c.Labels?.["iaas.protected"],
  }));
}
```

**After:**
```typescript
case "list_containers": {
  return containerService.list(userId, input.projectId as string | undefined);
}
```

Do this for EVERY case in `executeReadOnlyTool`. The function should shrink from ~300 lines to ~60 lines.

### Services to import

Add these imports at the top of `assistant.ts`:
```typescript
import { containerService } from '../services/containers.js';
import { bucketService } from '../services/buckets.js';
import { gatewayService } from '../services/gateway.js';
import { lambdaService } from '../services/lambda.js';
import { imageService } from '../services/images.js';
import { systemService } from '../services/system.js';
import { projectService } from '../services/projects.js';
```

### Tools that already call service-like modules

The database and GitHub read-only tools already delegate to `executeDatabaseAssistantReadOnlyTool()` and `executeGithubAssistantReadOnlyTool()`. Leave these as-is — they already call the right functions.

### Verification

- `npx tsc --noEmit` passes
- Start the dev server, open the assistant in the UI, and test: list containers, list buckets, list gateway routes. These should now return the same results as the REST API (with user scoping, ephemeral filtering, size data, etc.)

---

## Prompt 13: Add missing parameters to assistant tool schemas

In `server/src/routes/assistant.ts`, update the tool definition schemas to include fields that are currently missing.

### Changes to make

1. **`launch_container`** tool schema — add these properties to `input_schema.properties`:
   - `projectId: { type: "string", description: "Project ID to associate this container with" }`
   - `volumes: { type: "array", items: { type: "string" }, description: "Volume mounts (e.g. 'mydata:/app/data')" }`
   - `autoStart: { type: "boolean", description: "Start the container after creation (default: true)" }`

2. **`list_containers`** tool schema — add:
   - `projectId: { type: "string", description: "Filter by project ID" }`

3. **`list_functions`** tool schema — add:
   - `projectId: { type: "string", description: "Filter by project ID" }`

4. **`list_gateway_routes`** tool schema — add:
   - `projectId: { type: "string", description: "Filter by project ID" }`

5. **`list_buckets`** tool schema — add:
   - `projectId: { type: "string", description: "Filter by project ID" }`

These are additive changes — they don't break existing assistant behavior, they just make new parameters available.

### Verification

- `npx tsc --noEmit` passes
- The assistant UI still works — test launching a container with and without the new `projectId` field

---

## Prompt 14: Refactor assistant's mutating tool execution

The assistant's `/confirm` endpoint (for executing mutating tools) currently makes HTTP requests back to its own REST API. Refactor it to call service methods directly.

### What to change

Find the mutating tool execution logic in `assistant.ts` (the `/confirm` route handler). Currently it does something like:

```typescript
const response = await fetch(`http://127.0.0.1:${PORT}/api/containers`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, ... },
  body: JSON.stringify(body),
});
```

Replace these `fetch()` calls with direct service method calls:

```typescript
case 'launch_container':
  result = await containerService.launch(userId, body);
  break;
case 'create_bucket':
  result = await bucketService.create(userId, body.name, body.protected);
  break;
// etc.
```

This eliminates the HTTP round-trip and JWT re-authentication for every mutating tool call.

### The confirm flow still works the same way

The user confirmation flow (plan → pending → confirm) doesn't change. Only the execution mechanism changes from HTTP fetch to direct service call.

### Verification

- `npx tsc --noEmit` passes
- Test the full assistant loop: ask it to create a container, confirm the action, verify the container appears

---

## Prompt 15: Test the MCP server end-to-end

### 15a. Build and run the MCP server

```bash
cd mcp && npm run build
```

Fix any build errors. Then test it manually:

```bash
DOCKYARD_JWT=<a-valid-jwt> node dist/index.js
```

It should start and print "Dockyard MCP server running on stdio" to stderr.

### 15b. Test with a simple MCP client

Create a temporary test script `mcp/test-client.mjs`:

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, DOCKYARD_JWT: '<a-valid-jwt>' },
});

const client = new Client({ name: 'test', version: '1.0.0' });
await client.connect(transport);

// List tools
const tools = await client.listTools();
console.log(`Available tools: ${tools.tools.length}`);
console.log(tools.tools.map(t => t.name).join(', '));

// Test a read-only tool
const result = await client.callTool({ name: 'list_containers', arguments: {} });
console.log('Containers:', result.content[0].text);

await client.close();
```

### 15c. Configure Claude Code to use the MCP server

Add to `~/.claude/settings.json` or the project `.claude/settings.json`:

```json
{
  "mcpServers": {
    "dockyard": {
      "command": "node",
      "args": ["/path/to/docker-iaas/mcp/dist/index.js"],
      "env": {
        "DOCKYARD_JWT": "<a-valid-jwt>"
      }
    }
  }
}
```

### 15d. Verify in Claude Code

Restart Claude Code and test:
- "List my Dockyard containers"
- "Create a bucket called test-bucket"
- "Show me the system usage"

These should work through the MCP server calling the service layer directly.

---

## Summary of all new files

| File | Purpose |
|------|---------|
| `server/src/services/HttpError.ts` | Shared error class |
| `server/src/services/types.ts` | Shared type definitions |
| `server/src/services/system.ts` | System operations |
| `server/src/services/images.ts` | Docker image operations |
| `server/src/services/projects.ts` | Project CRUD |
| `server/src/services/volumes.ts` | Volume listing |
| `server/src/services/auth.ts` | Authentication operations |
| `server/src/services/notifications.ts` | Notification operations |
| `server/src/services/lambda.ts` | Lambda function operations |
| `server/src/services/host-files.ts` | Host file operations |
| `server/src/services/host-builds.ts` | Host build operations |
| `server/src/services/databases.ts` | Database operations wrapper |
| `server/src/services/buckets.ts` | S3 bucket operations |
| `server/src/services/gateway.ts` | Gateway route + DNS operations |
| `server/src/services/containers.ts` | Container lifecycle operations |
| `mcp/package.json` | MCP workspace package |
| `mcp/tsconfig.json` | MCP TypeScript config |
| `mcp/src/index.ts` | MCP server entry point |
| `mcp/src/auth.ts` | JWT/API key resolution |
| `mcp/src/tools.ts` | MCP tool definitions (~65 tools) |
| `mcp/src/handlers.ts` | MCP handler dispatch |

## Summary of all modified files

| File | Change |
|------|--------|
| `server/src/databaseManagement.ts` | Re-export HttpError from services/ |
| `server/src/routes/system.ts` | Thin route calling systemService |
| `server/src/routes/images.ts` | Thin route calling imageService |
| `server/src/routes/projects.ts` | Thin route calling projectService |
| `server/src/routes/volumes.ts` | Thin route calling volumeService |
| `server/src/routes/auth.ts` | Thin route calling authService |
| `server/src/routes/notifications.ts` | Thin route calling notificationService |
| `server/src/routes/lambda.ts` | Thin route calling lambdaService, re-exports from service |
| `server/src/routes/hostFiles.ts` | Thin route calling hostFileService, re-exports |
| `server/src/routes/hostBuilds.ts` | Thin route calling hostBuildService, re-exports |
| `server/src/routes/databases.ts` | Thin route calling databaseService |
| `server/src/routes/buckets.ts` | Thin route calling bucketService |
| `server/src/routes/gateway.ts` | Thin route calling gatewayService |
| `server/src/routes/containers.ts` | Thin route calling containerService, re-exports |
| `server/src/routes/assistant.ts` | Service method calls in executeReadOnlyTool, added params, direct service calls for mutations |
| `package.json` | Add "mcp" to workspaces |