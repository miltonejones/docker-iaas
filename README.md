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
- **Gateway** — named routes that map a clean URL (`/gw/<name>/...`) to a
  bucket (static file serving), a running container (full reverse proxy), or
  a lambda function (invoked with the request as structured input).

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
| `API_PROXY_TARGET`| `http://localhost:4300`   | Dev-only: where Vite proxies `/api`                |
| `MINIO_ENDPOINT`  | _(auto-detected)_         | Override the S3 API URL used to reach the persistent MinIO instance |

### Managing a remote host (EC2, another server)

Expose the remote Docker Engine over TCP (ideally with TLS), then:

```bash
DOCKER_HOST=tcp://my-ec2-host:2376 DOCKER_TLS_VERIFY=1 \
  DOCKER_CERT_PATH=~/.docker/certs npm start
```

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
| `GET  /api/gateway`                  | List gateway routes                  |
| `POST /api/gateway`                  | Create a route (`{ name, targetType, targetId, targetPort? }`) |
| `DELETE /api/gateway/:id`            | Delete a route                       |
| `*  /gw/:name/*`                     | The route itself — see below         |

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

## Notes & safety

- This console has **full control of the Docker daemon** it connects to — run
  it somewhere trusted and don't expose it publicly without auth in front.
- Presets are a starting point; edit `server/src/presets.ts` to add your own.
- The `dockyard-minio` container is system-managed (labeled `iaas.system=minio`)
  and hidden from the Containers page's Remove action; it's provisioned
  automatically on first start and its root credentials are generated once
  and persisted in the SQLite db.
- Adding auth, volume management UI, and container stats (CPU/mem) streaming
  are natural next steps.
