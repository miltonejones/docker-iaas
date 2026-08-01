# Prompt 06 — Automatic rollback to the last good image on failed deploy

You are an LLM coding agent working in `miltonejones/docker-iaas` (project
**Dockyard**). Deploys work like this today (`.github/workflows/deploy.yml`):
push to `main` → CI verifies (typecheck + tests) → smoke test → builds and
pushes `console` and `consumer` images to GHCR tagged with `${{ github.sha }}`
and `latest` → SSHes to the EC2 host, `git reset --hard origin/main`,
`docker compose down`, `docker compose pull`, `docker compose up -d`.

The gap: **if the new containers come up broken, nothing rolls back.** The
host is left on the bad version until a human intervenes — and because an
autonomous issue-fixing agent pushes to `main`, broken deploys can happen
with nobody watching. Every prior image tag already exists in GHCR, so
rollback is nearly free. Your task: add a post-deploy health gate and an
automatic rollback to the last known-good image tag.

## Global rules you must obey

- Branch: `gap/06-ci-rollback` from latest `origin/main`. Never push to
  `main`. Never force-push.
- **Protected-file authorization:** this prompt explicitly authorizes editing
  `.github/workflows/deploy.yml` — and ONLY that protected file. You must
  NOT touch: `Dockerfile.consumer`, `docker-compose.yml`,
  `docker-compose.ci.yml`, `Caddyfile`, `.gitignore`,
  `scripts/issue-consumer.mjs`, `scripts/protected-files.json`,
  `scripts/smoke-test-hardening.sh`. If you believe a compose change is
  needed, you are mistaken — the compose file already parameterizes images
  with `${IMAGE_TAG:-latest}`; the whole design below leans on that.
- Do not remove the `playwright` dependency.
- Keep the workflow's existing structure, comments, and step names intact;
  ADD to it, do not rewrite it.

## Facts you must internalize before editing

1. `docker-compose.yml` (do not edit; read it) sets
   `image: ghcr.io/miltonejones/docker-iaas-console:${IMAGE_TAG:-latest}` and
   the same pattern for the consumer. Therefore **which version runs is
   controlled entirely by the `IMAGE_TAG` environment variable** at
   `docker compose up` time. Rollback = re-run `compose up` with the previous
   good SHA as `IMAGE_TAG`. No compose edit needed.
2. The deploy step already exports `IMAGE_TAG="${IMAGE_TAG:-${{ github.sha }}}"`.
3. The server exposes `GET /api/system/ping` (daemon reachability + version).
   It is reachable on the host at `http://localhost:4300/api/system/ping`.
   Check whether it requires auth (`server/src/routes/system.ts` — it is
   currently `requireAuth`). A health gate must not need a login: Step 1
   adds an unauthenticated `GET /api/system/health`.
4. The deploy script already sources `/home/ec2-user/docker-iaas/.env` and
   already appends success/failure lines to
   `scripts/issue-logs/notifications.jsonl` — extend those patterns, don't
   reinvent them.

## Step-by-step instructions

### Step 1 — Server: unauthenticated health endpoint

In `server/src/routes/system.ts` add `GET /api/system/health` with **no
auth middleware** (deliberately public; it must leak nothing sensitive):

```json
{ "status": "ok", "version": "<package.json version>", "uptimeSec": 123, "docker": true }
```

- `docker` is the boolean result of the existing `pingDocker()` helper
  (`server/src/docker.ts`), with a 2-second timeout so the endpoint never
  hangs; on timeout return `"docker": false` but still HTTP 200 IF the web
  server itself is up — no, stop: define it precisely: HTTP 200 only when
  `docker === true`; HTTP 503 with the same JSON body when Docker is
  unreachable. The deploy gate treats non-200 as unhealthy, and a console
  that cannot reach Docker is not healthy.
- Response must NOT include: hostnames, file paths, env values, engine
  version details beyond Dockyard's own version.
- Add it to the auth-coverage test as an explicit, commented exception
  (`server/src/routes/authCoverage.test.ts`) so a future reader knows the
  lack of auth is intentional.

### Step 2 — Deploy workflow: record and read "last good tag" on the host

Edit `.github/workflows/deploy.yml`, deploy job, SSH script. The host keeps a
tiny state file `/home/ec2-user/docker-iaas/.last-good-tag` containing one
SHA. Modify the script as follows, preserving everything it already does:

1. **Before** the `docker compose down`, capture the candidate rollback tag:
   ```bash
   PREV_TAG=$(cat .last-good-tag 2>/dev/null || echo "")
   ```
2. After `docker compose up -d`, add a **health gate**:
   ```bash
   HEALTHY=0
   for i in $(seq 1 30); do
     if curl -sf --max-time 2 http://localhost:4300/api/system/health >/dev/null; then
       HEALTHY=1; break
     fi
     sleep 4
   done
   ```
   (30 × 4 s = up to 2 minutes; image pull already happened, so this
   tolerates slow starts without masking real failures.)
3. **On success** (`HEALTHY=1`): write the new tag as last-good —
   `echo "$IMAGE_TAG" > .last-good-tag` — then continue with the existing
   success-notification and issue-resolve logic UNCHANGED.
4. **On failure** (`HEALTHY=0`):
   ```bash
   echo "::error::Health gate failed for $IMAGE_TAG"
   if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$IMAGE_TAG" ]; then
     export IMAGE_TAG="$PREV_TAG"
     docker compose down || true
     docker compose pull console consumer || true
     docker compose up -d
     # Re-run the same health gate loop against the rolled-back version.
     # If THAT is healthy: append a notifications.jsonl entry
     #   level=error, summary="⏪ Deploy failed — rolled back to $PREV_TAG", body=$COMMIT_MSG
     # If even rollback is unhealthy: append
     #   level=error, summary="🔥 Deploy AND rollback failed — manual intervention required"
   else
     # No previous tag recorded (first deploy after this feature lands):
     # append level=error, summary="❌ Deploy failed — no rollback tag available"
   fi
   exit 1   # the workflow run must still be RED even after a successful rollback
   ```
   Implement the health-gate loop once as a shell function `wait_healthy()`
   at the top of the script and call it twice — do not paste the loop twice.
5. Pedantic requirements:
   - Every notification echo must follow the existing JSONL format in the
     script exactly (same fields: ts, level, summary, body).
   - `set -e` is active in this script: any command that is *allowed* to
     fail must carry `|| true`, and the health gate must be written so a
     failing `curl` does not abort the script (the `if curl ...` form shown
     is safe under `set -e`; keep that form).
   - Do NOT skip the issue-resolve block on success — leave it byte-for-byte
     intact and make sure your additions do not change its control flow.
   - The rollback path must NOT run `git reset` to an older commit. Code on
     disk stays at `origin/main`; only the *images* roll back. State this in
     a comment in the script: mixing an old image with new on-disk compose
     is safe here precisely because compose is protected/stable and
     parameterized by IMAGE_TAG. (Corollary, also in the comment: if a future
     deploy ever changes docker-compose.yml in a backwards-incompatible way,
     rollback needs `git checkout $PREV_TAG -- docker-compose.yml`; that is
     out of scope today.)

### Step 3 — Also gate on the consumer container

The console can be healthy while the consumer crash-loops. After the console
health gate passes, add:

```bash
CONSUMER_STATE=$(docker inspect -f '{{.State.Status}}' dockyard-consumer-ctr 2>/dev/null || echo missing)
CONSUMER_RESTARTS=$(docker inspect -f '{{.RestartCount}}' dockyard-consumer-ctr 2>/dev/null || echo 0)
```

If state is not `running` OR restarts > 2 within the gate window, treat it
as a WARNING, not a rollback trigger (the consumer is non-critical to
serving traffic): append a `level=warn` notification
(`"⚠️ Consumer unhealthy after deploy"`) and `echo "::warning::..."`, but do
not fail the deploy. Rationale to put in a comment: rolling back a healthy
console because the fixer bot is sick would reduce availability, not
increase it.

### Step 4 — Document

README "Deploying" section: add a short paragraph — health gate (2 min),
automatic image rollback to `.last-good-tag`, the workflow stays red on
rollback, consumer unhealthiness only warns, and the compose-change caveat
from Step 2.5.

### Step 5 — Tests / validation

CI workflow logic cannot be unit-tested here, so validation is:

1. `npm run typecheck && npm test` (server change from Step 1 is covered by
   a route test you add: `/api/system/health` returns 200 shape when
   `pingDocker` resolves ok — mock/stub per existing test idioms — and 503
   when it fails).
2. Lint the workflow YAML: run `npx yaml-lint .github/workflows/deploy.yml`
   if available, otherwise validate with
   `node -e "require('js-yaml')"`-style parse or `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy.yml'))"`.
   Any parse failure is a hard stop.
3. Shellcheck the embedded script: copy the script block to a temp file and
   run `shellcheck` if available; fix findings of severity error. If
   shellcheck is unavailable, say so in the PR description.
4. In the PR description, include a **dry-run table**: for each scenario
   (healthy deploy / unhealthy with prev tag / unhealthy without prev tag /
   unhealthy rollback / consumer crash-looping), list the exact notifications
   appended and the workflow conclusion. Derive it by reading your own
   script line by line.

## Things you must NOT do

- Do not edit `docker-compose.yml` or any other protected file besides
  `.github/workflows/deploy.yml`.
- Do not make the workflow green when a rollback occurred.
- Do not roll back on consumer unhealthiness.
- Do not delete or reorder the existing verify/smoke-test/build jobs.
- Do not add new GitHub secrets requirements.

## Acceptance criteria

1. A failed health gate automatically restores the previous image tag and
   the site comes back on the old version with no human action.
2. `.last-good-tag` is only advanced after a passing gate.
3. All five scenarios produce the documented notifications; the run is red
   whenever the pushed SHA did not end up serving.
4. `/api/system/health` is public, minimal, 200-iff-healthy, and covered by
   tests + the auth-coverage exception list.
5. Workflow YAML parses; `npm run typecheck`, `npm test`, `npm run lint`
   pass.

## Commit and push

Commits per step (`feat(gap-06): ...`), then
`git push -u origin gap/06-ci-rollback`; PR title
`feat: deploy health gate with automatic image rollback`.
Because this PR edits a consumer-protected file, its description must begin
with: `⚠️ Edits protected file .github/workflows/deploy.yml — human review
required before merge.`
