# Dockyard

A personal container management console — stand up and manage containers from a
gallery of presets in an **EC2-style** interface, with **disk usage front and
center** and reported continuously. Plus on-demand lambda functions.

![stack](https://img.shields.io/badge/stack-Node%20%2B%20React%20%2B%20dockerode-4f8cff)

## What it does

- **Launch gallery** — a curated set of "AMI-like" presets across Web, Database,
  Cache, Runtime, and OS categories: services (Nginx, Postgres, MySQL, MongoDB,
  Redis, WordPress, …) and a full spread of OS bases (BusyBox, Alpine, Ubuntu,
  Debian, Amazon Linux, Rocky, AlmaLinux, openSUSE, Arch, Fedora, Kali). Pick
  one, tweak ports/env, and launch. Missing images are pulled automatically.
- **Disk impact before you launch** — every preset carries an approximate
  on-disk / download footprint, and the gallery card and launch modal weigh it
  against your *current free space* live ("≈ 160 MB · 0.06% of free"), flagging
  heavy pulls and blocking any image that wouldn't fit.
- **Instance management** — start / stop / restart / remove containers, view
  logs, and see live state, published ports, age, and per-instance writable
  disk size.
- **Prominent disk usage** — a host-disk gauge (used / free / total) plus a
  Docker footprint breakdown (images, containers, volumes, build cache) with a
  one-click **Reclaim space** (prune) action.
- **Reported regularly** — usage streams to the browser over Server-Sent
  Events and refreshes every few seconds (`USAGE_POLL_MS`), with a live/stale
  indicator. No manual refresh.
- **Buckets** — a single, persistent MinIO instance that Dockyard provisions
  and manages itself (like its own SQLite db). Create/delete S3-compatible
  buckets and browse, upload, download, or delete objects, all from the UI.
- **Host file copies** — Ask Dockyard can copy one explicitly named host file
  to a bucket or a running container after showing a confirmation. Transfers
  preserve binary data and are limited to 200 MiB per file.
- **Gateway** — named routes that map a clean URL (`/gw/<name>/...`) to a
  bucket (static file serving), a running container (full reverse proxy), or
  a lambda function (invoked with the request as structured input). The server
  also records bounded gateway traffic telemetry (last 10k requests) for
  route-level summaries and recent-request inspection.
- **External DB management foundation** — the server can now store encrypted
  MySQL and MongoDB connections, inspect schemas, run bounded read queries,
  preview/execute confirmed mutations, migrations, structured MySQL/MongoDB
  grants, and record backup / restore jobs for smaller datasets.

## Architecture

```
dockyard/
  server/   Express + dockerode REST API and SSE usage stream (TypeScript, ESM)
  web/      React + Vite dashboard (TypeScript)
  scripts/  dev launcher that runs both together
  Dockerfile / docker-compose.yml  run the console itself as a container
```

The server talks to the Docker Engine API via `dockerode`. Host disk usage
comes from `fs.statfs`; the Docker footprint comes from the engine's
`/system/df`. The frontend proxies `/api` to the server in dev and is served
statically by the server in production.

## Quick start (local)

Requires Node 18.15+ (for `fs.statfs`) and a reachable Docker daemon.

```bash
cd dockyard
npm install          # installs both workspaces
npm run dev          # server on :4300, web on :5173 (proxied)
# open http://localhost:5173
```

Production-style single process (server serves the built UI):

```bash
npm run build
npm start            # http://localhost:4300
```

## Run the console itself in Docker

```bash
cd dockyard
docker compose up --build
# open http://localhost:4300
```

`docker-compose.yml` mounts `/var/run/docker.sock` (to manage the daemon) and
`/:/host:ro` with `HOST_DISK_PATH=/host` (so the gauge reports the *host*
disk, not the container overlay).

## Configuration

All optional — sensible defaults are used.

| Variable          | Default                   | Purpose                                            |
| ----------------- | ------------------------- | -------------------------------------------------- |
| `PORT`            | `4300`                    | Server listen port                                 |
| `DOCKER_SOCKET`   | `/var/run/docker.sock`    | Local daemon socket                                |
| `DOCKER_HOST`     | _(unset)_                 | `tcp://host:2375` to manage a **remote** engine    |
| `DOCKER_TLS_VERIFY` / `DOCKER_CERT_PATH` | _(unset)_ | TLS for a remote engine (port 2376)     |
| `HOST_DISK_PATH`  | `/`                       | Filesystem path measured by the disk gauge         |
| `USAGE_POLL_MS`   | `5000`                    | Usage stream refresh interval                      |
| `HOST_COMMAND_PRESETS` | `[]`                  | JSON array of fixed host-build presets              |
| `HOST_BUILD_HELPER_SOCKET` | `/tmp/dockyard-host-build.sock` | Socket for the host build helper        |
| `API_PROXY_TARGET`| `http://localhost:4300`   | Dev-only: where Vite proxies `/api`                |
| `MINIO_ENDPOINT`  | _(auto-detected)_         | Override the S3 API URL used to reach the persistent MinIO instance |
| `DOCKYARD_DATABASE_MASTER_KEY` | _(optional override)_ | Secret used to AES-256-GCM encrypt saved MySQL/MongoDB credentials at rest |
| `DOCKYARD_DATABASE_MASTER_KEY_FILE` | `~/.dockyard_database_master_key` | Compose secret file for the database credential encryption key |
| `ASSISTANT_PROVIDER` | `anthropic` | Assistant provider: `anthropic` or `deepseek` |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_API_KEY_FILE` | _(unset)_ | DeepSeek API credential override |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | DeepSeek main assistant model |
| `DEEPSEEK_TITLE_MODEL` | `deepseek-v4-flash` | DeepSeek assistant session-title model |

### DeepSeek assistant provider

Dockyard can use DeepSeek's Anthropic-compatible API for its assistant. Store
the DeepSeek API key outside the repository, then set:

```bash
ASSISTANT_PROVIDER=deepseek
DEEPSEEK_API_KEY_FILE=/path/to/deepseek-api-key
```

With Docker Compose, the key is mounted as `/run/secrets/deepseek_api_key`.
Restart or recreate the `console` service after changing the provider or key.

### Managing a remote host (EC2, another server)

Expose the remote Docker Engine over TCP (ideally with TLS), then:

```bash
DOCKER_HOST=tcp://my-ec2-host:2376 DOCKER_TLS_VERIFY=1 \
  DOCKER_CERT_PATH=~/.docker/certs npm start
```

  ### Host build presets

  Run `scripts/host-build-helper.mjs` directly on the host to enable confirmed
  assistant builds. The helper only accepts a preset name; it never accepts a
  shell command or arguments from Dockyard.

  ```bash
  export HOST_COMMAND_PRESETS='[
    {
      "name": "frontend-build",
      "cwd": "/home/me/projects/frontend",
      "command": "npm",
      "args": ["run", "build"],
      "artifacts": "dist"
    }
  ]'
  node scripts/host-build-helper.mjs
  ```

  Use the same `HOST_COMMAND_PRESETS` value for Dockyard itself. With the
  provided Compose file, start the helper with
  `HOST_BUILD_HELPER_SOCKET="$PWD/data/host-build-helper.sock"`; that directory
  is already mounted into Dockyard at `/app/data`. Then run
  `docker compose up --build`. Ask Dockyard to run `frontend-build` and deploy
  it to a running container; it shows the preset, container, and destination
  for confirmation before running. `cwd` is an absolute host path and
  `artifacts` is a relative directory within it. The generated artifact tree is
  limited to 200 MiB and excludes symlinks.

### External database management

The server now exposes a backend foundation for managing saved **MySQL** and
**MongoDB** connections:

- saved connections are stored in SQLite, while the full connection config
  (including credentials / URI auth) is encrypted at rest with
  **AES-256-GCM** using `DOCKYARD_DATABASE_MASTER_KEY`
- schema inspection is supported for both engines
- read queries are bounded (result count / payload / execution-time caps)
- mutations, migrations, grants, backups, and restores are built for a
  **client-confirmation** flow: without `confirmed: true`, the API returns a
  preview payload instead of executing
- MySQL grants are structured server-side (validated account, privilege list,
  scope, and optional `WITH GRANT OPTION`) and MongoDB role grants call
  `grantRolesToUser` with validated usernames / role specs
- backup / restore jobs are recorded in SQLite and artifacts are written under
  `data/database-backups/`

`DOCKYARD_DATABASE_MASTER_KEY` is required to create, update, decrypt, test,
inspect, query, back up, or restore saved DB connections. Existing saved
connections become unreadable if you change that key later.

Supported saved connection payloads:

- **MySQL**: `{ host, port?, database, username, password?, ssl? }`
- **MongoDB field mode**:
  `{ mode: "fields", host, port?, database, username?, password?, authDatabase?, directConnection?, tls? }`
- **MongoDB URI mode**:
  `{ mode: "uri", uri, database }`

Current built-in safety limits:

- read queries: max **200 rows**, max **256 KiB** response payload, max **8s**
  query time target
- Mongo aggregate pipelines: max **25** stages, `$out` / `$merge` rejected
- migration step arrays: max **20** steps
- built-in backup artifacts: max **25 MiB** and intended for smaller datasets

Current backup caveats:

- MySQL backups are Dockyard JSON exports of **base tables + row data** only;
  they do **not** currently preserve views, triggers, routines, or events
- MongoDB backups are Dockyard **EJSON** exports of collection documents plus
  index metadata
- restores replace the tables / collections present in the selected backup
  artifact

## REST API

| Method / path                        | Description                          |
| ------------------------------------ | ------------------------------------ |
| `GET  /api/system/ping`              | Daemon reachability + engine version |
| `GET  /api/system/presets`           | The launch gallery                   |
| `GET  /api/system/usage`             | One-shot usage snapshot              |
| `GET  /api/system/usage/stream`      | SSE stream of usage snapshots        |
| `GET  /api/containers`               | List instances (with sizes)          |
| `POST /api/containers`               | Launch (from `presetId` or `image`)  |
| `POST /api/containers/:id/{start,stop,restart}` | Lifecycle actions         |
| `DELETE /api/containers/:id?force=`  | Remove an instance                   |
| `GET  /api/containers/:id/logs`      | Recent logs                          |
| `GET  /api/images`                   | List images                          |
| `POST /api/images/prune`            | Reclaim dangling images + stopped containers |
| `GET  /api/buckets`                  | List buckets                         |
| `POST /api/buckets`                  | Create a bucket (`{ name }`)         |
| `DELETE /api/buckets/:name`          | Delete an (empty) bucket             |
| `GET  /api/buckets/:name/objects?prefix=` | List objects under a prefix     |
| `PUT  /api/buckets/:name/objects/*`  | Upload an object (raw body)          |
| `GET  /api/buckets/:name/objects/*`  | Download an object                   |
| `DELETE /api/buckets/:name/objects/*`| Delete an object                     |
| `POST /api/host-files/to-bucket`     | Copy a confirmed host file to a bucket (`{ sourcePath, bucket, key, contentType? }`) |
| `POST /api/host-files/to-container`  | Copy a confirmed host file to a container (`{ sourcePath, id, path }`) |
| `GET  /api/host-builds/presets`      | List configured host build presets             |
| `POST /api/host-builds/run`          | Run a preset and deploy its artifacts (`{ preset, id, path }`) |
| `GET  /api/gateway`                  | List gateway routes                  |
| `POST /api/gateway`                  | Create a route (`{ name, targetType, targetId, targetPort? }`) |
| `DELETE /api/gateway/:id`            | Delete a route                       |
| `GET  /api/gateway/traffic/summary?windowHours=&gatewayName=&routeId=&targetType=` | Route-level gateway traffic summary |
| `GET  /api/gateway/traffic/requests?windowHours=&limit=&gatewayName=&routeId=&targetType=&method=&statusCode=&errorClassification=` | Recent gateway request events |
| `GET  /api/databases/overview`       | Saved DB overview, limits, recent ops/jobs |
| `GET  /api/databases/connections`    | List saved MySQL/MongoDB connections |
| `POST /api/databases/connections`    | Create a saved connection (`{ name, engine, config }`) |
| `GET  /api/databases/connections/:id`| Read one saved connection summary    |
| `PUT  /api/databases/connections/:id`| Update a saved connection            |
| `DELETE /api/databases/connections/:id` | Delete a saved connection         |
| `POST /api/databases/connections/:id/test` | Test a saved connection       |
| `GET  /api/databases/connections/:id/schema?database=` | Inspect schema metadata |
| `POST /api/databases/connections/:id/read` | Run bounded read query        |
| `POST /api/databases/connections/:id/grant` | Preview/execute structured MySQL/MongoDB grants (`confirmed: true` to run) |
| `POST /api/databases/connections/:id/mutate` | Preview/execute mutation (`confirmed: true` to run) |
| `POST /api/databases/connections/:id/migrate` | Preview/execute migration (`confirmed: true` to run) |
| `POST /api/databases/connections/:id/backup` | Preview/execute backup job (`confirmed: true` to run) |
| `POST /api/databases/connections/:id/restore` | Preview/execute restore job (`{ jobId, confirmed: true }`) |
| `GET  /api/databases/operations?limit=` | List recent mutation/migration/grant ops |
| `GET  /api/databases/jobs?limit=`    | List backup / restore jobs           |
| `GET  /api/databases/jobs/:id`       | Read one backup / restore job        |
| `GET  /api/databases/jobs/:id/download` | Download the saved backup artifact |
| `*  /gw/:name/*`                     | The route itself — see below         |

### Assistant client contracts for DB actions

No `AssistantBar` wiring was added here, but the server now defines assistant
tool names for future client support. A client executor should map these names
to the REST endpoints above:

- `list_database_connections` → `GET /api/databases/connections`
- `get_database_connection` → `GET /api/databases/connections/:id`
- `get_database_operations_overview` → `GET /api/databases/overview`
- `inspect_database_schema` → `GET /api/databases/connections/:id/schema`
- `run_database_read_query` → `POST /api/databases/connections/:id/read`
- `list_database_jobs` → `GET /api/databases/jobs`
- `get_database_job` → `GET /api/databases/jobs/:id`
- `create_database_connection` → `POST /api/databases/connections`
- `update_database_connection` → `PUT /api/databases/connections/:id`
- `delete_database_connection` → `DELETE /api/databases/connections/:id`
- `test_database_connection` → `POST /api/databases/connections/:id/test`
- `execute_database_access_grant` → `POST /api/databases/connections/:id/grant`
- `execute_database_mutation` → `POST /api/databases/connections/:id/mutate`
- `execute_database_migration` → `POST /api/databases/connections/:id/migrate`
- `create_database_backup` → `POST /api/databases/connections/:id/backup`
- `restore_database_backup` → `POST /api/databases/connections/:id/restore`

Expected tool arguments:

- all mutating tools take `connectionId`
- MySQL reads use `{ connectionId, sql }`
- Mongo reads use `{ connectionId, collection, database?, mode?, filter?, projection?, sort?, limit?, pipeline? }`
- access grants use MySQL `{ connectionId, username, host, privileges: string[], database, table?, withGrantOption? }` or MongoDB `{ connectionId, username, authDatabase, roles: (string | { role, db })[] }`
- MySQL mutations use `{ connectionId, statement }`
- MySQL migrations use `{ connectionId, statements: string[] }`
- Mongo mutations use `{ connectionId, operation, collection, database?, document?, documents?, filter?, update?, upsert? }`
- Mongo migrations use `{ connectionId, steps: [...] }`
- backup uses `{ connectionId, database? }`
- restore uses `{ connectionId, jobId, targetDatabase? }`

For `grant`, `mutate`, `migrate`, `backup`, and `restore`, the REST API returns
a preview unless the client sends `confirmed: true`. `execute_database_access_grant`
is the assistant/client action name for structured grant requests; after
confirmation, the client should resend the same tool input with `confirmed: true`.
Successful grant responses include the executed result plus `operation` and
`operationHistory` entries from the server's database-operation log.

### Gateway routes

Each route lives at `/gw/<name>/...` and maps to one of three target types:

- **`bucket`** — read-only static serving. The remaining path is used as the
  object key; a path ending in `/` (or the route root) serves `index.html`.
- **`container`** — a full reverse proxy (any method, headers, body streamed
  through) to `targetPort` on the target container.
- **`lambda`** — invokes the saved function on every request, using the same
  event/response shape as a real **AWS API Gateway → Lambda proxy
  integration**, so code written against it should run on actual Lambda
  with little to no change. The event is passed in as JSON via a
  `DOCKYARD_REQUEST` environment variable — readable as
  `process.env.DOCKYARD_REQUEST` (Node), `os.environ['DOCKYARD_REQUEST']`
  (Python), or `$DOCKYARD_REQUEST` (Shell):
  ```ts
  { httpMethod, path, headers, queryStringParameters, pathParameters, body, isBase64Encoded }
  ```
  `body` is always a raw string (or `null`) — never pre-parsed, just like the
  real event. The function must print a matching proxy **response** to
  stdout:
  ```ts
  { statusCode, headers?, body?, isBase64Encoded? }
  ```
  e.g. in Node: `console.log(JSON.stringify({ statusCode: 200, body: JSON.stringify({ ok: true }) }))`.
  If stdout isn't valid JSON or is missing a numeric `statusCode`, the
  gateway returns `502` — the same "malformed Lambda proxy response"
  failure mode real API Gateway produces, so a broken handler fails the
  same way locally as it would in AWS.

### Gateway traffic telemetry

Every `/gw/:name/*` request writes one server-side telemetry row to SQLite,
including route misses and target failures. Stored fields are:

```ts
{
  occurredAt,
  gatewayName,
  routeId,
  targetType,
  method,
  path,
  statusCode,
  durationMs,
  requestBytes,
  responseBytes,
  errorClassification
}
```

Notes:

- query string values, request bodies, `Authorization`, `Cookie`, and other
  sensitive headers are **not** persisted
- `requestBytes` is derived from the declared body size when available
- telemetry retention is capped at the newest **10,000** events

`GET /api/gateway/traffic/summary` returns:

```ts
{
  windowHours,
  since,
  until,
  filters: { gatewayName, routeId, targetType },
  totalRequests,
  routes: [
    {
      gatewayName,
      routeId,
      targetType,
      routeMethod,
      routePathPattern,
      requestCount,
      successfulRequests,
      clientErrorRequests,
      serverErrorRequests,
      avgDurationMs,
      maxDurationMs,
      totalRequestBytes,
      totalResponseBytes,
      lastSeenAt,
      errorCounts
    }
  ]
}
```

`GET /api/gateway/traffic/requests` returns:

```ts
{
  windowHours,
  since,
  until,
  limit,
  filters: {
    gatewayName,
    routeId,
    targetType,
    method,
    statusCode,
    errorClassification
  },
  totalMatched,
  requests: [
    {
      id,
      occurredAt,
      gatewayName,
      routeId,
      targetType,
      method,
      path,
      statusCode,
      durationMs,
      requestBytes,
      responseBytes,
      errorClassification
    }
  ]
}
```

## Notes & safety

- This console has **full control of the Docker daemon** it connects to — run
  it somewhere trusted and don't expose it publicly without auth in front.
- Host-file transfers use the directory mounted at `HOST_DISK_PATH` (`/host`
  in the supplied Docker Compose configuration). They can read any regular
  host file visible through that mount, so confirm the exact source and
  destination carefully.
- Presets are a starting point; edit `server/src/presets.ts` to add your own.
- The `dockyard-minio` container is system-managed (labeled `iaas.system=minio`)
  and hidden from the Containers page's Remove action; it's provisioned
  automatically on first start and its root credentials are generated once
  and persisted in the SQLite db.
- Adding auth, volume management UI, and container stats (CPU/mem) streaming
  are natural next steps.
