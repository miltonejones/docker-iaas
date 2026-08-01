# Prompt 09 — Hard (non-prompt) enforcement of the protected-files list

You are an LLM coding agent working in `miltonejones/docker-iaas` (project
**Dockyard**). Dockyard's autonomous issue consumer edits this repository
and pushes fixes. A list of files it must never modify exists at
`scripts/protected-files.json` (the consumer itself, the compose files, the
deploy workflow, the Caddyfile, `.gitignore`, the smoke test). Today that
list is enforced primarily by **prompt instruction** — the consumer's system
prompt tells the model not to touch them. A prompt is not a security
boundary: a confused or manipulated model can ignore it, and history proves
the risk is real — commit `8fdfd1f` shows an autonomous commit deleting an
entire workspace (`mcp/`) as collateral damage in an unrelated fix.

Your task: make the protection **mechanical**, at three independent layers,
so no single failure (model disobedience, local hook bypass, direct push)
lets a protected file change land unreviewed.

## Global rules you must obey

- Branch: `gap/09-protected-enforcement` from latest `origin/main`. Never
  push to `main`. Never force-push.
- Protected files — in this prompt you must NOT edit any of them, INCLUDING
  the ones this task is about. Specifically you may READ
  `scripts/protected-files.json` and `scripts/issue-consumer.mjs` but not
  modify them. Everything you build lives in NEW files plus one new GitHub
  workflow. (If enforcement seems to require editing the consumer, see
  Step 4 — it does not.)
- Do not remove the `playwright` dependency.
- Zero new npm dependencies.

## The three layers you will build

| Layer | Mechanism | Catches |
|-------|-----------|---------|
| 1 | CI check workflow (`.github/workflows/protected-files.yml`) that fails any PR or push whose diff touches a protected file without explicit human authorization | everything that goes through GitHub — the authoritative layer |
| 2 | Repo-local verification script (`scripts/check-protected-files.mjs`) runnable anywhere (CI layer 1 calls it; developers and the consumer's own pipeline can call it) | drift between list and reality; local pre-push use |
| 3 | GitHub branch-protection documentation + CODEOWNERS | direct pushes to `main`; ensures layer 1 is *required* |

## Step-by-step instructions

### Step 1 — The verification script (build this first; CI wraps it)

Create `scripts/check-protected-files.mjs` (Node 22, ESM, zero deps):

1. Inputs (argv):
   - `--base <ref>` and `--head <ref>` — the commit range to inspect
     (defaults: `origin/main...HEAD`).
   - `--allow-label` — optional flag meaning "authorization present"
     (CI passes it when the PR carries the override label, Step 2.3).
2. Behavior, exactly:
   a. Read and parse `scripts/protected-files.json` **from the BASE ref**,
      not the working tree: `git show <base>:scripts/protected-files.json`.
      Pedantic reason you must preserve in a comment: if the list were read
      from the head/working tree, an attacker (or confused agent) could
      first edit the list to empty it, then edit the formerly protected
      files — same commit, check passes. Reading the base ref's list makes
      the list itself protected by the list (it contains its own path).
   b. `git diff --name-only <base>...<head>` (three-dot: changes on the head
      side only), plus `git diff --name-only --diff-filter=D` merged in —
      deletions and renames (`--diff-filter=R` → check BOTH old and new
      names) count as touching.
   c. Intersect with the protected list. Exact path match — the list
      contains file paths, not globs. If any entry in the list ends with
      `/`, treat it as a directory prefix (future-proofing; document it).
   d. If the intersection is empty: print `OK: no protected files touched`
      and exit 0.
   e. If non-empty and `--allow-label` absent: print each violating path on
      its own line prefixed `PROTECTED:`, then a paragraph explaining what
      to do (quote it from Step 2.3's override procedure), exit 1.
   f. If non-empty and `--allow-label` present: print `OVERRIDE: …` lines
      and exit 0.
3. Edge cases to handle explicitly (with tests, Step 5): base ref where the
   JSON does not exist yet (fall back to head's copy, warn), malformed JSON
   (exit 2, distinct code, message `protected-files.json is not valid JSON`
   — a corrupt list must fail CLOSED, not open), empty diff, rename of a
   protected file (both sides flagged).

### Step 2 — CI workflow (layer 1)

Create `.github/workflows/protected-files.yml` (a NEW file — allowed):

1. Triggers: `pull_request` (types: opened, synchronize, reopened,
   labeled, unlabeled) and `push` to `main`.
2. Job `check` on `ubuntu-latest`, ~5 min timeout:
   - `actions/checkout@v4` with `fetch-depth: 0` (the script needs history
     for base...head; document this in a comment — shallow clones break
     `git show base:…`).
   - For `pull_request` events: base = `${{ github.event.pull_request.base.sha }}`,
     head = `${{ github.event.pull_request.head.sha }}`.
     Determine the override: the PR has the label
     `protected-change-approved` **AND** — belt and braces —
     `github.event.pull_request.user.login != 'app/bot accounts used by the consumer'`…
     stop, simpler and stronger: the override label alone is sufficient,
     BECAUSE only humans with triage+ permission can apply labels and the
     consumer's token must not have that permission (Step 3 documents this
     requirement). Pass `--allow-label` iff the label is present.
   - For `push` to `main`: base = `${{ github.event.before }}`, head =
     `${{ github.sha }}`, never pass `--allow-label` — pushes to main that
     touch protected files always fail this check, loudly flagging that the
     branch-protection layer was bypassed. Guard the zero-SHA case
     (`0000000…` on branch creation → skip with a notice).
3. This workflow must be listed as a **required status check** on `main`.
   You cannot set that from inside the repo — it is a GitHub settings
   change. Produce the instructions in Step 3.

### Step 3 — Branch protection + CODEOWNERS documentation (layer 3)

1. Create `.github/CODEOWNERS` (new file) mapping every protected path to
   the repo owner:
   ```
   /docker-compose.yml        @miltonejones
   /docker-compose.ci.yml     @miltonejones
   /Dockerfile.consumer       @miltonejones
   /Caddyfile                 @miltonejones
   /.gitignore                @miltonejones
   /.github/workflows/        @miltonejones
   /scripts/issue-consumer.mjs        @miltonejones
   /scripts/protected-files.json      @miltonejones
   /scripts/smoke-test-hardening.sh   @miltonejones
   ```
   Note `/.github/workflows/` covers the deploy workflow AND prevents the
   consumer from quietly adding a new workflow that exfiltrates secrets —
   mention this in the doc.
2. Create `docs/protected-files-enforcement.md` documenting the whole
   scheme, including the **manual GitHub settings a human must apply** (be
   explicit; these cannot be automated from the repo):
   - Branch protection / ruleset on `main`: require the
     `protected-files / check` status check; require PRs (no direct
     pushes); require CODEOWNERS review for matching paths.
   - Create the `protected-change-approved` label (color red, description
     "Human-approved change to consumer-protected files").
   - **Consumer token scope**: the PAT the consumer pushes with must NOT
     have permission to add labels or approve PRs — its authorization
     ceiling is exactly what keeps the override human-only. List the
     minimal scopes: `contents: write` on this repo, nothing else.
   - The residual gap, stated honestly: with plain branch protection, the
     consumer's `contents: write` PAT could still push to non-main branches
     and open PRs — fine — and the CI check + required review stop those
     PRs from merging. The scheme's soundness rests on (a) required status
     check, (b) label permissions, (c) CODEOWNERS review. If any of the
     three is not configured, say which attacks reopen.
3. The deploy workflow currently deploys on push to `main`. After branch
   protection, the consumer's direct pushes to `main` (if it does that
   today — READ `scripts/issue-consumer.mjs` and report in the PR
   description whether it pushes to `main` or to `consumer/*` branches with
   PRs; the git log shows `consumer/fix-*` branch merges, so PRs are
   likely) continue working unchanged through PRs. Document whatever you
   find as the "current consumer flow" in the doc.

### Step 4 — What you must NOT build

Explicitly rejected approaches — do not implement any of these, and say why
in the doc (one line each):

- Editing `scripts/issue-consumer.mjs` to add self-policing (protected file;
  and self-policing by the thing being policed is circular).
- A git `pre-commit`/`pre-push` hook as the primary control (hooks are
  client-side, trivially bypassed, not versioned by default).
- A server-side `pre-receive` hook (GitHub.com does not support custom
  pre-receive hooks on ordinary repos).
- Making files read-only in the consumer container via mounts (the consumer
  pushes via the GitHub remote; filesystem permissions in one container do
  not bind the git history).

### Step 5 — Tests

`scripts/check-protected-files.test.mjs`, runnable by the existing root
test script pattern (`node --test scripts/*.test.mjs` — verify the root
`test` script's glob picks it up):

1. Build throwaway git repos in `os.tmpdir()` inside the tests (`git init`,
   commit list + files, branch, modify). Cover: clean diff → 0; modified
   protected file → 1 with `PROTECTED:` line; deleted → 1; renamed → 1;
   list-emptied-then-file-edited in same range → 1 (the base-ref rule
   proving its worth — this is the most important test in the file);
   `--allow-label` → 0 with `OVERRIDE:`; malformed JSON at base → exit 2.
2. Workflow YAML parses (same validation approach as other prompts:
   `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/protected-files.yml'))"`).

## Acceptance criteria

1. `node scripts/check-protected-files.mjs --base origin/main --head HEAD`
   works locally and exits 0 on this branch (this branch touches no
   protected files — that is itself the proof).
2. The base-ref self-protection property holds and is tested.
3. CI workflow exists, parses, distinguishes PR/push/label cases, and fails
   closed on malformed input.
4. CODEOWNERS + the enforcement doc (with the exact manual settings and the
   honest residual-gap analysis) exist.
5. `npm run typecheck`, `npm test`, `npm run lint` pass, and the new test
   file runs in the root `npm test`.

## Verification

```bash
npm test
node scripts/check-protected-files.mjs --base origin/main --head HEAD
# then, deliberately, in a scratch branch: touch docker-compose.yml, commit,
# run the script, confirm exit 1 + PROTECTED: line, then discard the branch.
```

Paste both runs' output into the PR description.

## Commit and push

Commits per step (`feat(gap-09): ...`), then
`git push -u origin gap/09-protected-enforcement`; PR title
`feat: mechanical enforcement of the protected-files list (CI + CODEOWNERS)`.
The PR description must end with a checklist of the manual GitHub settings
a human still has to flip, copied from the doc.
