# Deploy Pipeline Improvements

> Extracted from the ng-sploosh CI/CD buildout — a full end-to-end pipeline that
> builds an Angular 21 micro-frontend workspace (8 apps), assembles them into a
> single nginx container, and deploys with a `git push`.
>
> The pipeline works, but these six areas need attention.

---

## 1. Root-cause the esbuild deadlock — don't workaround it

**Problem:**

On GitHub Actions runners (ubuntu-latest, Node 20), `ng build` with
`@angular-architects/native-federation` triggers a Go goroutine deadlock in
esbuild during shutdown. The build output IS written, but esbuild's service
mode crashes with a non-zero exit code:

```
fatal error: all goroutines are asleep - deadlock!
goroutine 1 [chan receive]:
github.com/evanw/esbuild/internal/helpers.(*ThreadSafeWaitGroup).Wait(...)
```

**Current fragile workaround:**

Building `shared-utils` first (`ng build shared-utils --configuration=production`)
BEFORE any of the 8 application builds prevents the deadlock. Without this step,
the build produces zero output on GitHub Actions. This took 20 workflow runs to
discover and is not documented anywhere.

**What needs to happen:**

1. Pinpoint which esbuild version / `@angular/build` version introduces the
   deadlock. It reproduces on ubuntu-latest but NOT in the Alpine dev container
   (node:22-alpine). The difference is likely the Go binary platform variant.

2. Options to fix:
   - Set `ESBUILD_BINARY_PATH` in CI to a known-good, pre-downloaded esbuild
     binary that doesn't have the shutdown deadlock.
   - Pin `@angular/build` to a version before the regression.
   - Disable esbuild's service mode: investigate `ESBUILD_SERVICE=0` or
     equivalent environment variable.
   - If none of the above work, wrap all `ng build` calls with a post-build
     check: verify `dist/$app/browser/index.html` (or `remoteEntry.json` for
     remotes) exists, and fail the step if not. The `|| true` / `continue-on-error`
     pattern masks real build failures.

**Acceptance criteria:**

- A single `npm ci && npx ng build host-app --configuration=production` succeeds
  on ubuntu-latest without workarounds.
- The build order dependency (shared-utils first) is removed from the workflow
  or documented as an intentional requirement with a clear reason.

---

## 2. Atomic deploys — eliminate the 502 gap

**Problem:**

`pull_github_repo_to_container` with `clean: true` deletes ALL files in the
nginx document root before writing the new ones. During the gap between deletion
and completion, nginx serves partial content or 404s. The gateway returns 502
while files are being written. This is visible to users.

**Proposed fix:**

1. Write new files to a timestamped staging directory:
   ```
   /usr/share/nginx/html-staging-1712345678/
   ```

2. After all files are written and verified, atomically swap the symlink:
   ```bash
   ln -sfn /usr/share/nginx/html-staging-1712345678 /usr/share/nginx/html
   ```

3. Clean up old staging directories (keep last 2-3).

**Implementation notes:**

- nginx config must use `disable_symlinks off;` (the default) so it follows the
  symlink.
- The `pull_github_repo_to_container` API should accept a `strategy` parameter:
  `"direct"` (current behavior — write directly to path) or `"atomic"` (staging
  directory + symlink swap).
- For containers that don't support symlinks (e.g., Windows-based images),
  fall back to a rename of directories at the filesystem level.

**Alternative (simpler):**

Write to a staging path, then use `mv` (same filesystem = atomic on Linux) to
swap the directory. This doesn't require symlink support:

```bash
mv /usr/share/nginx/html /usr/share/nginx/html-old
mv /usr/share/nginx/html-staging /usr/share/nginx/html
rm -rf /usr/share/nginx/html-old
```

**Acceptance criteria:**

- A deployment never causes a 502 or serves a partial/missing file.
- Zero-downtime deploys measured by concurrent curl requests during deployment.

---

## 3. Gateway route creation should accept all fields upfront

**Problem:**

`create_gateway_route` doesn't accept `targetPort` at creation time. For container
targets, a port is required — but the only way to set it is to create the route,
then delete it, then recreate it with the port. This breaks domain associations
and DNS records.

**What happened:**

The original `ng-sploosh-prod` route (`rt-mt6f7i`) was created without
`targetPort`. It worked for a while (likely via a Caddy default), then broke.
Recreating it with `targetPort: 80` required deleting the route, which dropped
the domain `ai.sploosh.me.uk`, DNS records, and TLS configuration. All three
had to be manually reassembled.

**Fix:**

1. `create_gateway_route` should accept `targetPort` for container targets and
   make it required when `targetType` is `"container"`.

2. `update_gateway_route` should support changing `targetPort`, `method`,
   `pathPattern`, and `domain` — not just `displayName`. Currently the only way
   to change these is a delete + recreate.

3. Domain assignment on route creation: if a `domain` is passed to
   `create_gateway_route`, it should set the domain AND create the DNS record
   in one operation.

**Acceptance criteria:**

- Creating a container-targeted route with a domain and port is a single API call.
- Changing a route's port or domain doesn't require deletion.

---

## 4. Eliminate the `console` DNS hard-dependency in Caddy

**Problem:**

Every gateway route's Caddy configuration hardcodes `console` as the upstream
hostname. This is baked into the Caddyfile generation. If the container named
`console` is renamed, stopped, or has a Docker DNS resolution failure, EVERY
routed site goes 502 — not just one.

**What happened:**

After the `pull-to-container` API call, the `console` hostname stopped resolving
in Caddy's Docker DNS (`127.0.0.11:53`). Both `ai.sploosh.me.uk` and
`ai.codezoom.nl` went 502 simultaneously. The fix required renaming the Dockyard
service container to `console` to match the hardcoded value.

**Proposed fix:**

1. Make the upstream hostname configurable — read from an environment variable
   (`CADDY_UPSTREAM_HOST`) with a default of `console`.
2. OR: resolve gateway route targets to their container's internal Docker IP
   at Caddyfile generation time, rather than using a hostname that can go stale.
3. OR: add a `console` network alias to the dockyard service in docker-compose
   so the name `console` resolves regardless of the container's `container_name`.

**Acceptance criteria:**

- Renaming the dockyard container does not break all gateway routes.
- Gateway routes survive Docker DNS cache expiry without 502s.

---

## 5. Webhook secret — auto-provision, don't ask

**Problem:**

The `POST /api/github/pull-to-container` endpoint requires an `x-webhook-secret`
header. There's no way to:
- Generate a webhook secret from the Dockyard UI
- Retrieve an existing webhook secret via API
- Rotate the secret

I had to ask the operator to provide the secret value manually, then the user
had to copy-paste it into GitHub Secrets. This is a manual, error-prone step
that blocks the pipeline.

**Proposed fix:**

1. Add `GET /api/webhook-secret` — returns the current secret (requires admin
   auth).
2. Add `POST /api/webhook-secret/rotate` — generates a new secret, invalidates
   the old one.
3. On first Dockyard startup, auto-generate a webhook secret and store it
   persistently (docker-compose env or DB).
4. Show the secret in the Dockyard settings UI with a copy button.

**Why this matters:**

Without this, every CI/CD pipeline that wants to call Dockyard's deploy API
requires a manual out-of-band secret exchange. This doesn't scale beyond one
project.

**Acceptance criteria:**

- A new Dockyard install has a webhook secret available at `GET /api/webhook-secret`
  without manual configuration.
- The secret can be rotated from the UI or API.
- CI/CD onboarding docs say: "Copy your webhook secret from Settings → Webhooks."

---

## 6. `commit_and_push_github_files` — support new branches

**Problem:**

The tool requires the target branch to already exist on the remote. It cannot
create a branch. When building the ng-sploosh pipeline, I needed to push to a
new `deploy-prod` branch to avoid triggering the existing `main`-based workflows.
The tool failed:

```
git checkout failed: error: pathspec 'deploy-prod' did not match any file(s) known to git
```

**Workaround used:**

First commit the file to `main`, then push a follow-up commit to `deploy-prod`
(which then existed). This required two commits and temporarily put the workflow
file on main.

**Fix:**

Add an optional `baseBranch` parameter to `commit_and_push_github_files`:

```json
{
  "owner": "miltonejones",
  "repo": "ng-sploosh",
  "branch": "deploy-prod",
  "baseBranch": "main",
  "message": "...",
  "files": [...]
}
```

When `branch` doesn't exist on the remote:
1. Create it from `baseBranch` (default: the repo's default branch)
2. Write files, commit, push

**Acceptance criteria:**

- Creating a new branch and committing to it in one call works.
- If `baseBranch` is omitted, the repo's default branch is used.
- Existing behavior (push to existing branch) is unchanged.

---

## Summary

| # | Improvement | Impact |
|---|------------|--------|
| 1 | Fix esbuild deadlock at root | Removes fragile build-order workaround |
| 2 | Atomic deploys | Zero-downtime, no 502 blip |
| 3 | Gateway route full create/update | No delete→recreate dance |
| 4 | Eliminate `console` DNS coupling | Gateway routes survive container renames |
| 5 | Auto-provision webhook secret | CI/CD onboarding is self-service |
| 6 | Branch creation in commit tool | No two-step branch creation |
