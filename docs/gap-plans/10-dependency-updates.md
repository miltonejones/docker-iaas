# Prompt 10 — Dependabot configuration and dependency update policy

You are an LLM coding agent working in `miltonejones/docker-iaas` (project
**Dockyard**). The repo has no automated dependency updating — no
Dependabot, no Renovate. That is notable for a security-sensitive tool that
holds database credentials, a GitHub token, and a mounted Docker socket
(root-equivalent on its host). Your task: configure Dependabot with a
deliberately conservative policy, plus documentation of how updates flow
through this repo's unusual automation (auto-deploy on merge to `main`).

## Global rules you must obey

- Branch: `gap/10-dependency-updates` from latest `origin/main`. Never push
  to `main`. Never force-push.
- Protected files — do NOT touch: `Dockerfile.consumer`, `docker-compose.yml`,
  `docker-compose.ci.yml`, `Caddyfile`, `.gitignore`,
  `.github/workflows/deploy.yml`, `scripts/issue-consumer.mjs`,
  `scripts/protected-files.json`, `scripts/smoke-test-hardening.sh`.
- **Do not upgrade any dependency yourself in this PR.** This prompt
  configures the *machinery*; the updates themselves arrive later as
  Dependabot PRs for human review. The one exception is Step 4 (a security
  audit REPORT — still no upgrades).
- Do not remove the `playwright` dependency, and see Step 2.4 for its
  special handling.

## Context you must understand

1. This is an npm **workspaces** monorepo: root + `server` + `web` +
   `relay` (+ `mcp` if prompt 00 has landed — check whether `mcp/` exists
   and include it if so). There is ONE `package-lock.json` at the root.
   Dependabot's npm ecosystem handles workspaces from the root directory —
   you configure `directory: "/"` once, NOT one entry per workspace
   (multiple entries against the same lockfile create duplicate/conflicting
   PRs).
2. Merging to `main` **auto-deploys to production** (`deploy.yml`). A
   dependency PR is therefore a production deploy. The policy below exists
   because of that fact; restate it in the docs you write.
3. CI (`deploy.yml` verify job) runs typecheck + unit tests on PRs. If
   prompt 07 landed, e2e tests also run on PRs. These are the safety net
   for dependency PRs — mention in docs which are active at time of
   writing.
4. There are also GitHub Actions to update (`actions/checkout@v4`, etc.) and
   two Dockerfiles (`Dockerfile`, `Dockerfile.consumer`) whose base images
   Dependabot can track. Note: tracking a Dockerfile's base image does NOT
   edit protected compose files — `Dockerfile` is not on the protected
   list, but `Dockerfile.consumer` IS. See Step 2.3 for how to handle that.

## Step-by-step instructions

### Step 1 — `.github/dependabot.yml`

Create `.github/dependabot.yml` (new file, not protected) with exactly
these update blocks:

```yaml
version: 2
updates:
  # npm — one block for the whole workspace monorepo (single root lockfile)
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
      day: monday
      time: "06:00"
      timezone: America/Chicago
    open-pull-requests-limit: 5
    versioning-strategy: increase-if-necessary
    groups:
      # Batch low-risk updates to cut PR noise; security PRs ignore groups.
      minor-and-patch:
        applies-to: version-updates
        update-types: ["minor", "patch"]
    ignore:
      # Majors arrive one-by-one so each gets its own review & test run.
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]
    labels: ["dependencies"]
    commit-message:
      prefix: "chore(deps)"

  # GitHub Actions
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
      day: monday
      time: "06:30"
      timezone: America/Chicago
    open-pull-requests-limit: 3
    labels: ["dependencies", "ci"]
    commit-message:
      prefix: "chore(ci)"

  # Docker base image for the console image only.
  # Dockerfile.consumer is on the consumer-protected list; its base image
  # updates must be authored by a human, so it is deliberately excluded.
  - package-ecosystem: docker
    directory: "/"
    schedule:
      interval: weekly
      day: monday
      time: "07:00"
      timezone: America/Chicago
    open-pull-requests-limit: 2
    labels: ["dependencies", "docker"]
    commit-message:
      prefix: "chore(docker)"
```

Pedantic verification of your own YAML: Dependabot's `docker` ecosystem
with `directory: "/"` picks up every Dockerfile in that directory — which
would include `Dockerfile.consumer`. Check the current Dependabot docs
behavior; if per-file exclusion is impossible, ACCEPT that Dependabot may
open a PR against `Dockerfile.consumer` and rely on the protected-files CI
check (prompt 09) plus CODEOWNERS to force human review — and write this
interaction down in Step 3's doc. Do not silently drop the docker block.

### Step 2 — Policy decisions to encode and document

State each of these in the doc (Step 3), with its reason:

1. **Majors excluded from auto-PRs.** Every semver-major (Express 4→5,
   better-sqlite3, dockerode, React 18→19, Vite, mongodb driver) is a
   hand-run migration. The doc lists the currently-pinned majors and marks
   the known-risky ones: `express` (v5 changes middleware error semantics —
   this app leans hard on middleware ordering), `better-sqlite3` (native
   module, node ABI), `dockerode` (API surface), `react`/`react-dom`
   (concurrent-mode implications for the SSE-driven UI), `mongodb`
   (driver API), `tar-stream` v2→v3 (used by lambda packaging AND, if
   prompt 05 landed, self-backup).
2. **Weekly, grouped, capped at 5 PRs** — this repo's PR review bandwidth is
   one human; an unbounded Monday flood guarantees rubber-stamping, which
   is worse than lateness.
3. **Security updates** are exempt from the weekly cadence and the groups —
   Dependabot opens them immediately. State that these get priority review.
4. **`playwright` is special**: it is a *production* dependency of the
   server whose version is coupled to browser binaries baked into the
   console image at build time. A playwright bump PR must be checked
   against the `Dockerfile`'s browser-install step (read the Dockerfile and
   document the exact coupling you find — search it for `playwright`).
   If patch/minor playwright bumps would break that coupling, add
   `playwright` to the npm `ignore:` list with update-types for
   minor+patch too, and note that playwright is then human-managed
   entirely. Decide based on what the Dockerfile actually does — read it,
   then choose, and record the choice + reason in the doc.
5. **The `deps` phantom**: if prompt 00 has NOT yet landed and the stray
   `"deps": "^1.0.0"` is still in the root package.json, add it to
   `ignore:` and put a warning in the doc — Dependabot must never "update"
   an accidental package. (If 00 landed, skip this.)

### Step 3 — Documentation

Create `docs/dependency-policy.md`:

- The flow: Dependabot PR → CI (typecheck, unit, e2e if present, smoke) →
  human review → merge → **automatic production deploy** (+ automatic
  rollback if prompt 06 landed — check and state which).
- The table of majors from Step 2.1 with risk notes.
- The playwright decision and its Dockerfile coupling.
- The `Dockerfile.consumer` / protected-files interaction from Step 1.
- A quarterly manual task: run `npm audit` and `npm outdated -ws --long`,
  review majors, schedule migrations. Put the exact commands in the doc.

### Step 4 — Baseline audit report (no upgrades!)

Run and capture into the PR description (NOT committed files):

```bash
npm audit --omit dev 2>&1 | tail -30
npm audit 2>&1 | tail -5
npm outdated -ws --long 2>&1 | head -40
```

Summarize: counts of critical/high/moderate vulns (prod vs dev), and the
five most-behind dependencies. If `npm audit` reports critical prod
vulnerabilities, list them at the TOP of the PR description under
`⚠️ Pre-existing critical vulnerabilities (not fixed by this PR)` — do not
fix them here; they become the first Dependabot/security PRs.

### Step 5 — Validate

1. YAML parses:
   `python3 -c "import yaml,sys; yaml.safe_load(open('.github/dependabot.yml'))"`.
2. Field sanity: cross-check every key against the current Dependabot
   config reference (`groups`, `applies-to`, `versioning-strategy` are the
   ones LLMs most often get subtly wrong — verify spelling and placement).
3. `npm run typecheck && npm test && npm run lint` still pass (they should
   be untouched — this PR adds YAML and markdown only; if anything fails,
   you changed something you should not have).

## Things you must NOT do

- Do not upgrade, add, or remove any dependency.
- Do not enable Dependabot auto-merge anywhere, and say in the doc why it
  is forbidden in this repo: merge = production deploy, and an autonomous
  consumer already pushes code — two robots merging without a human closes
  the loop on unreviewed production changes.
- Do not configure Renovate as well; one bot.
- Do not add per-workspace npm blocks.
- Do not touch any protected file.

## Acceptance criteria

1. `.github/dependabot.yml` exists, parses, and matches the policy: weekly,
   grouped minor/patch, majors ignored, ≤5 npm PRs, actions + docker
   ecosystems configured, consumer-Dockerfile interaction documented.
2. `docs/dependency-policy.md` covers flow, majors table, playwright
   decision, quarterly task.
3. PR description contains the baseline audit summary (with the critical
   banner if applicable).
4. No dependency changed: `git diff origin/main -- package-lock.json` is
   empty.
5. `npm run typecheck`, `npm test`, `npm run lint` pass.

## Commit and push

Two commits (`chore(gap-10): add dependabot configuration`,
`docs(gap-10): dependency update policy`), then
`git push -u origin gap/10-dependency-updates`; PR title
`chore: Dependabot configuration and dependency policy`.
