## Deploy optimization: reduce deploy time from ~6min to ~2min

### Current breakdown

| Step | Time | Notes |
|---|---|---|
| Verify (typecheck/test/build) | ~1m | On GitHub runner, fine |
| Checkout + protected check | ~2s | |
| **`docker compose build --no-cache console`** | **~2-3m** | Full rebuild: npm install + tsc + vite |
| `docker compose up -d console` | ~5s | |
| `docker compose stop consumer` | ~2s | |
| **`docker compose build --no-cache consumer`** | **~2-3m** | Full rebuild: npm install + copy |
| `docker compose up -d consumer` | ~5s | |
| Issue resolve curls | ~20s | Token exchange + PATCH retries |
| **Total** | **~5-7m** | |

### Why it's slow

1. **`--no-cache` forces a full rebuild every time.** Two Docker images each doing
   `npm install` (hundreds of packages) + TypeScript compilation + Vite bundle —
   from scratch, every deploy, even when only one CSS file changed. The `--no-cache`
   was added because Docker on EC2 wasn't busting the build cache on server-side
   file changes — but that was likely a one-time daemon cache corruption, not a
   systematic problem. Content-based caching (`--build`) with `COPY . .` should
   correctly invalidate on content hashes in the normal case.

2. **The two builds run sequentially.** Console and consumer are independent builds
   (different Dockerfiles, no build-time dependency between them). Building both at
   once would cut total build time to `max(console, consumer)` instead of `console + consumer`.

3. **The consumer is rebuilt even when its source hasn't changed.** Most pushes to
   main are consumer-authored PRs changing only `web/src/*` files. The consumer
   (`scripts/issue-consumer.mjs`, `Dockerfile.consumer`) changes rarely. We could
   check whether consumer source files changed before deciding to rebuild.

### Proposed changes

#### 1. Console: `--no-cache` → `--build`

Replace:
```bash
docker compose build --no-cache console
```
with:
```bash
docker compose build --build console
```

Docker's `COPY . .` layer computes content hashes of all source files. If nothing
changed, the layer is cached and the build skips `npm install` + `npm run build`.
If something changed (even one file), only the layers above the last changed COPY
rebuild. This is how Docker is supposed to work — if cache doesn't bust on the EC2
host again, that's a daemon-level issue, not a deploy script workaround.

**Expected saving: 1-2 minutes per deploy** (when only web files changed, the
server compilation layer is cached).

#### 2. Consumer: skip rebuild when unchanged

After `git fetch && git reset --hard`, check if consumer-related files differ from
the previous commit:

```bash
if git diff --name-only HEAD~1 HEAD | grep -qE "^scripts/issue-consumer|^Dockerfile.consumer"; then
  docker compose stop consumer 2>/dev/null || true
  docker compose build --no-cache consumer && docker compose up -d consumer || \
    docker compose up -d consumer
else
  docker compose up -d consumer  # restart with existing image
fi
```

The consumer is Node.js in a container — restarting picks up codebase changes
from the host mount. Rebuilding is only needed when the consumer's own source or
Dockerfile changes. Most consumer-authored PRs only touch `web/src/` — those
don't need a consumer rebuild.

**Expected saving: 2-3 minutes on most deploys** (consumer-authored PRs).

#### 3. Parallelize console and consumer builds

Start both builds simultaneously, wait for both to finish:

```bash
# Build console in background
docker compose build --build console &
CONSOLE_PID=$!

# Build consumer (with conditional logic) in background
if git diff --name-only HEAD~1 HEAD | grep -qE "^scripts/issue-consumer|^Dockerfile.consumer"; then
  (docker compose stop consumer 2>/dev/null; docker compose build --no-cache consumer) &
  CONSUMER_PID=$!
  CONSUMER_BUILD=true
else
  CONSUMER_PID=""
  CONSUMER_BUILD=false
fi

# Wait for builds to finish
wait $CONSOLE_PID
[ -n "$CONSUMER_PID" ] && wait $CONSUMER_PID

# Start services
docker compose up -d --remove-orphans console caddy
if [ "$CONSUMER_BUILD" = true ]; then
  docker compose up -d consumer
else
  docker compose up -d consumer
fi
```

**Expected saving: cuts total build time from additive to max of the two** (roughly
halved in the case where both need rebuilding).

### Expected outcome

| Scenario | Before | After |
|---|---|---|
| Consumer PR (web file change only) | ~6 min | ~2 min |
| Consumer PR (consumer source change) | ~6 min | ~3 min |
| Human PR (server change) | ~6 min | ~3 min |
| Human PR (server + web) | ~6 min | ~4 min |

### Implementation notes

- Keep `--no-cache` for consumer when it DOES need rebuilding — Dockerfile-only
  changes still don't invalidate cache reliably, so we keep the sledgehammer there.
- Don't touch the verify job or the protected-files step — they're fast.
- The `git diff` check uses `HEAD~1` which is available because the checkout step
  uses `fetch-depth: 2`.
- If the Docker daemon on EC2 has persistent cache corruption, add a weekly cron
  `docker builder prune -af` rather than burning `--no-cache` on every deploy.
