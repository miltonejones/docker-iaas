# Prompt 05 — Backup and restore of Dockyard's own state

You are an LLM coding agent working in `miltonejones/docker-iaas` (project
**Dockyard**). Dockyard has backup tooling for *external* MySQL/MongoDB
databases, but **no backup story for its own state**: the SQLite database
(users, gateway routes, lambda functions and files, saved encrypted DB
connections, settings, telemetry) and the MinIO bucket data. Losing the
`./data` directory loses everything. Your task: a first-class self-backup
(export) and restore feature.

## Global rules you must obey

- Branch: `gap/05-self-backup` from latest `origin/main`. Never push to
  `main`. Never force-push.
- Protected files — do NOT touch: `Dockerfile.consumer`, `docker-compose.yml`,
  `docker-compose.ci.yml`, `Caddyfile`, `.gitignore`,
  `.github/workflows/deploy.yml`, `scripts/issue-consumer.mjs`,
  `scripts/protected-files.json`, `scripts/smoke-test-hardening.sh`.
- Do not remove the `playwright` dependency.
- No new dependencies except ONE allowed: `archiver` OR reuse the already
  present `tar-stream` (STRONG preference: reuse `tar-stream`, it is already
  a server dependency used by the lambda service — read
  `server/src/services/lambda.ts` `packFilesToTar` for the idiom). Decide,
  and justify the decision in one sentence in the PR description.

## Read first

1. `server/src/db.ts` — where the SQLite file lives (find the exact path;
   search for `better-sqlite3` constructor), what tables exist.
2. `server/src/minio.ts` and `server/src/services/buckets.ts` — how buckets
   and objects are accessed (S3 client), where MinIO's credentials live.
3. `server/src/services/databases.ts` / `server/src/databaseManagement.ts` —
   the EXISTING backup-job pattern for external DBs (jobs recorded in
   SQLite, artifacts under `data/database-backups/`). Your feature must
   follow the same job-record UX so the UI concepts match.
4. `server/src/routes/system.ts` — where the new admin endpoints belong.
5. `server/src/encryption.ts` — how the DB master key is loaded; you will
   need to WARN about it (see Step 1.4).

## Semantics you must implement exactly

A **backup** is a single tar.gz file containing:

```
dockyard-backup/
  manifest.json          # { version: 1, createdAt, appVersion, contents: {...}, counts per table, bucket list }
  sqlite/dockyard.db     # a CONSISTENT snapshot (see Step 1.2), plus -wal/-shm if present after checkpoint (should not be)
  buckets/<bucket>/<key> # every object of every user bucket (see Step 2)
```

What a backup does NOT contain (state each in `manifest.json` under
`excluded` and in the README):

- container images/containers/volumes (recreatable; out of scope),
- `scripts/issue-logs/` (ephemeral logs),
- the database **master key** and JWT secret (secrets never enter a backup),
- Caddy certificates.

## Step-by-step instructions

### Step 1 — Backup service (SQLite part)

Create `server/src/services/selfBackup.ts`.

1. Job model: reuse the existing jobs table if the external-DB backup jobs
   table is generic enough (inspect its columns); if it is
   engine/connection-specific, create a new table `self_backup_jobs`
   (id, type `backup`|`restore`, status `running`|`done`|`failed`, startedAt,
   finishedAt, artifactPath, sizeBytes, error) using the established
   migration idiom in `db.ts`.
2. **Consistent SQLite snapshot — do this exactly:** better-sqlite3 exposes
   `db.backup(destinationPath)` (async, non-blocking, does a proper online
   backup). Use it. Do NOT `fs.copyFile` the live DB — with WAL mode and
   concurrent writes a raw copy can be torn/corrupt. After `db.backup`
   completes, the destination is a self-contained consistent DB file.
3. Stream the tar: write to
   `data/self-backups/dockyard-backup-<ISO-timestamp>.tar.gz` via
   `tar-stream` pack → `zlib.createGzip()` → `fs.createWriteStream`, adding
   the snapshot file, the manifest, then bucket objects (Step 2). Never
   buffer whole objects in memory: pipe each S3 GetObject stream into a tar
   entry (tar-stream requires entry size up front — use the object's
   ContentLength from list/stat metadata; if unknown, buffer that single
   object but cap at 200 MiB, matching the codebase's existing transfer cap,
   and skip+record larger objects in the manifest under `skipped`).
4. If `DOCKYARD_DATABASE_MASTER_KEY` is set, add to the manifest:
   `"warning": "Saved external-DB connections are encrypted with a master key that is NOT in this backup. Restoring on a host without the same key makes them unreadable."`
   Also surface this string in the UI (Step 4).
5. Retention: keep the newest `SELF_BACKUP_KEEP` (env, default 5) archives in
   `data/self-backups/`; delete older ones after each successful backup and
   record what was deleted in the job log.
6. Concurrency guard: one self-backup or restore at a time — a module-level
   lock; concurrent request → 409 `'A backup or restore is already running.'`

### Step 2 — Backup service (MinIO part)

1. List all buckets via the existing bucket service, then all objects per
   bucket (handle pagination — the S3 `ListObjectsV2` continuation token; the
   existing bucket service may already paginate: check, reuse).
2. Skip Dockyard-internal/system buckets ONLY if such exist (search for a
   system bucket concept; if none, back up everything).
3. Tar entry path exactly `buckets/<bucket>/<key>`. Keys may contain `/` —
   that is fine in tar. Keys must NOT be able to escape the prefix on
   restore: on RESTORE, reject any tar entry whose normalized path contains
   `..` or starts with `/` (classic tar-slip; write an explicit check with a
   test).

### Step 3 — Restore service

Restore is deliberately blunt and clearly documented as such:

1. `restoreFromArchive(artifactPathOrUploadedFile, { confirmed })` —
   without `confirmed: true`, return a PREVIEW: read only `manifest.json`
   from the tar (stream until found), return its contents + the warning
   string. This mirrors the repo's established preview/confirm pattern for
   external DB operations — read that flow and match the response shapes.
2. With `confirmed: true`:
   a. Extract sqlite snapshot to `data/dockyard-restore-incoming.db`,
      integrity-check it (`PRAGMA integrity_check` via a fresh better-sqlite3
      handle; must return `ok`), else fail the job without touching anything.
   b. Bucket objects: for each `buckets/<bucket>/<key>` entry, create the
      bucket if missing and PUT the object (streaming). Existing objects with
      the same key are overwritten; objects not in the backup are LEFT ALONE
      (document: restore is additive/overwriting for buckets, not a sync).
   c. SQLite swap: the live server cannot safely hot-swap its own open DB.
      Implement the pragmatic single-node approach: close the better-sqlite3
      handle (add a `closeDb()` to `db.ts`), rename live db →
      `dockyard-pre-restore-<ts>.db` (kept as an escape hatch), rename
      incoming → live path, then `process.exit(0)` after responding — the
      container's `restart: unless-stopped` policy brings the server back up
      on the restored DB. Respond FIRST
      (`{ ok: true, restarting: true, note: 'Dockyard is restarting on the restored database.' }`),
      flush, then exit on a 500 ms timer. Document this restart behavior
      loudly in the UI confirm dialog and README.
3. Restore requires the `admin` role if prompt 01 (RBAC) has landed — check
   whether `requireRole` exists in `server/src/auth.ts`; if yes use
   `requireRole('admin')`, if not use `requireAuth` and leave a
   `// TODO(gap-01)` comment.

### Step 4 — Routes and UI

1. Routes (in `server/src/routes/system.ts` or a new
   `server/src/routes/selfBackup.ts` mounted at `/api/self-backup` —
   prefer the new file):
   - `POST /api/self-backup/backups` — start a backup job (async; returns
     the job immediately; job progresses in background).
   - `GET /api/self-backup/backups` — list jobs + artifacts on disk.
   - `GET /api/self-backup/backups/:id/download` — stream the tar.gz
     (Content-Disposition attachment; sanitize the filename).
   - `POST /api/self-backup/restore` — body `{ jobId?, confirmed }` for an
     on-disk artifact, OR multipart/raw upload of an archive (raw body route
     mounted BEFORE the JSON parser — copy the mounting comment/idiom from
     `server/src/index.ts` around the bucket-object routes; this ordering is
     a known footgun in this codebase, respect it).
2. UI: a "Backup & restore" card in `web/src/pages/Settings.tsx`:
   - Back up now button → job list with status/size/date, download links.
   - Restore: pick an existing artifact or upload one → preview screen
     rendering the manifest counts + the master-key warning → typed
     confirmation (user must type the word `restore`) → call with
     `confirmed: true` → show "Dockyard is restarting…" and poll
     `/api/system/ping` until it answers, then reload the page.
3. Notifications: emit `info` notifications on backup completed / restore
   completed via the existing notification service.

### Step 5 — Tests

1. Round-trip test (pure, no Docker needed): build a temp SQLite db with a
   few rows + fake object streams → run the tar-building function → untar
   with `tar-stream` extract in the test → assert manifest counts, file
   presence, and byte-for-byte object content.
2. `PRAGMA integrity_check` failure path: feed a corrupt file, expect the
   job to fail and the live DB path untouched.
3. Tar-slip: an archive entry named `buckets/../../etc/passwd` must be
   rejected (assert the specific error).
4. Preview vs confirmed behavior of the restore route (supertest).
5. Concurrency: second backup request during a running one → 409.

## Things you must NOT do

- Never `fs.copyFile` the live SQLite database.
- Never include the master key, JWT secret, or any `/run/secrets` content in
  an archive.
- No cron/scheduling in this prompt (a follow-up may add scheduled backups;
  note it in the PR description as future work).
- No S3-remote backup targets — local artifact + user-downloaded file only.
- Do not touch docker-compose.yml (the `data/` mount already covers the new
  `data/self-backups/` path).

## Acceptance criteria

1. One click produces a downloadable tar.gz with consistent SQLite snapshot,
   all bucket objects, and an honest manifest (incl. exclusions/warnings).
2. Restore previews before executing, restores buckets additively, swaps the
   DB safely with integrity check and pre-restore copy, and self-restarts.
3. Tar-slip is impossible; secrets never enter archives; retention prunes to
   `SELF_BACKUP_KEEP`.
4. README gains a "Backing up Dockyard itself" section covering: what is/is
   not included, the master-key caveat, the restart-on-restore behavior.
5. `npm run typecheck`, `npm test`, `npm run lint` pass.

## Verification

```bash
npm run typecheck && npm test && npm run lint
# Manual with dev server + Docker + MinIO available: run a backup from
# Settings, download it, `tar -tzf` it and paste the first 20 entries into
# the PR description; then restore it and confirm the app comes back.
```

## Commit and push

Commits per step (`feat(gap-05): ...`), then
`git push -u origin gap/05-self-backup`; PR title
`feat: Dockyard self-backup and restore (SQLite + MinIO)`.
