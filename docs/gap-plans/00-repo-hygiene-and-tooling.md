# Prompt 00 — Repo hygiene: stray dependency, MCP workspace restore, ESLint/Prettier, untracked artifacts

You are an LLM coding agent working in the repository
`miltonejones/docker-iaas` (a project called **Dockyard** — a personal Docker
container management console). Your task in this prompt is **housekeeping
only**: no features, no behavior changes to the running product. Read this
entire file before touching anything.

## Global rules you must obey

- Work on a branch named `gap/00-repo-hygiene`. Create it from the latest
  `origin/main`. Never commit to `main` directly. Never force-push.
- **Do NOT remove the `playwright` dependency from `server/package.json`.**
  It looks unusual as a server production dependency, but it is required (it
  powers preview/screenshot endpoints). Leave it exactly as it is.
- The following files are on the consumer's protected list
  (`scripts/protected-files.json`): `Dockerfile.consumer`,
  `docker-compose.yml`, `docker-compose.ci.yml`, `Caddyfile`, `.gitignore`,
  `.github/workflows/deploy.yml`, `scripts/issue-consumer.mjs`,
  `scripts/protected-files.json`, `scripts/smoke-test-hardening.sh`.
  **In this prompt you are explicitly permitted to edit exactly one of them:
  `.gitignore` (Step 4).** Do not touch any of the others for any reason.
- After every step, run the verification commands for that step before moving
  on. If a command fails, stop and fix it. Do not proceed on top of a failure.

## Background you need to understand

1. **The stray `deps` package.** The root `package.json` contains
   `"deps": "^1.0.0"` in its `dependencies`. This is not a real dependency of
   this project. It is an accidentally installed npm package (someone
   almost certainly typed `npm install deps` by mistake). Accidental packages
   like this are a supply-chain risk and must be removed.
2. **The missing `mcp` workspace.** The root `package.json` declares four
   workspaces: `server`, `web`, `relay`, `mcp` — but the `mcp/` directory does
   not exist in the working tree. It is NOT lost: it was added in commit
   `2c1aaa6` ("feat: extract service layer and add MCP server") and then
   deleted — apparently unintentionally, as part of a broad cleanup — by
   commit `8fdfd1f` ("fix(iss-1785273898270-41lzhh): assistant-input"). The
   full MCP server source still exists in git history at `8fdfd1f^` (the
   commit immediately before the deletion). Your job is to restore it and
   wire it back up, NOT to write a new MCP server from scratch.
3. **No linter or formatter exists.** There is no ESLint or Prettier
   configuration anywhere in the repo. Because an autonomous AI agent (the
   issue consumer) edits this codebase, automated lint gates are unusually
   important here.
4. **Committed build artifacts / logs.** `scripts/issue-logs/` contains over
   100 machine-generated markdown log files that are committed to git. The
   directory `testing/aidj-test/` appears to be a stray test artifact.

## Step-by-step instructions

### Step 1 — Create the branch

```bash
git fetch origin main
git checkout -b gap/00-repo-hygiene origin/main
```

### Step 2 — Remove the stray `deps` dependency

1. Open the **root** `package.json` (the one at the repository root, NOT
   `server/package.json`, NOT `web/package.json`).
2. In its `dependencies` object, delete the line `"deps": "^1.0.0",`.
3. Do NOT delete `bcryptjs` or `jsonwebtoken` from the root in this step —
   they are handled in Step 3.
4. Run `npm install` at the repo root so `package-lock.json` is regenerated
   without `deps`. Commit both `package.json` and `package-lock.json`.

Verification for this step:

```bash
grep -rn '"deps"' package.json && echo "FAIL: deps still present" || echo "OK"
npm ls deps 2>&1 | grep -q "empty" && echo "OK" || npm ls deps
```

### Step 3 — Move misplaced root dependencies into the server workspace

The root `package.json` declares `bcryptjs`, `jsonwebtoken`,
`@types/bcryptjs`, and `@types/jsonwebtoken`. These are used only by server
code (`server/src/auth.ts` imports `jsonwebtoken`; search the server for
`bcryptjs` usage with `grep -rn "bcryptjs" server/src`). Root-level
dependencies in a workspace monorepo are a smell: they hide which package
actually needs what.

1. Confirm where each package is imported:
   `grep -rn "from 'jsonwebtoken'\|from \"jsonwebtoken\"\|require('jsonwebtoken')" server web relay scripts --include='*.ts' --include='*.mjs' -l`
   and the same for `bcryptjs`. Expect hits only under `server/src/`.
   If you find a hit under `scripts/` or another workspace, list every
   importer in your PR description and add the dependency to EACH importing
   workspace, not just server.
2. Add `bcryptjs` and `jsonwebtoken` to `server/package.json`
   `dependencies`, and the two `@types/*` packages to its `devDependencies`,
   using the same version ranges currently in the root.
3. Remove all four from the root `package.json`.
4. Run `npm install` at the root to update `package-lock.json`.

Verification:

```bash
npm run typecheck        # must pass — proves imports still resolve
npm test                 # must pass
```

### Step 4 — Stop tracking generated logs and stray artifacts

**This step edits `.gitignore`, which is protected. That edit is explicitly
authorized for this prompt only.**

1. Look at what is currently tracked:
   `git ls-files scripts/issue-logs | head` and `git ls-files testing`.
2. `scripts/issue-logs/*.md` files are machine-generated run logs from the
   issue consumer. They must remain on disk on the production host (the
   consumer and notification system write there at runtime) but must not be
   version-controlled. Do the following:
   - Append these lines to `.gitignore` (keep every existing line untouched):
     ```
     scripts/issue-logs/*.md
     scripts/issue-logs/*.jsonl
     testing/
     ```
   - Remove the already-tracked files from the index WITHOUT deleting them
     from disk: `git rm -r --cached scripts/issue-logs/ testing/`.
   - Create `scripts/issue-logs/.gitkeep` (empty file) and add a negation
     line `!scripts/issue-logs/.gitkeep` to `.gitignore`, so the directory
     itself continues to exist on fresh clones (server code appends to
     `scripts/issue-logs/notifications.jsonl` and must not crash on a missing
     directory).
3. Check whether any code does `fs.readdir` / `fs.readFile` on files under
   `scripts/issue-logs/` at startup and would break if the `.md` files are
   absent on a fresh clone:
   `grep -rn "issue-logs" server/src scripts --include='*.ts' --include='*.mjs' | grep -v test`.
   Read each hit. All known usages create-or-append; if you find one that
   hard-requires an existing file, make it tolerate absence (create the file
   on first write) and mention it in the PR description.

Verification:

```bash
git status --porcelain | grep issue-logs   # should show deletions from index only
ls scripts/issue-logs | head               # files still on disk
npm test                                   # nothing depended on tracked logs
```

### Step 5 — Restore the MCP workspace from git history

Do NOT write a new MCP server. Restore the deleted one:

1. Restore the directory exactly as it was immediately before deletion:
   ```bash
   git checkout 8fdfd1f^ -- mcp/
   ```
   After this, `mcp/` must contain at least: `package.json`, `tsconfig.json`,
   `src/index.ts`, `src/auth.ts`, `src/handlers.ts`, `src/tools.ts`.
2. Run `npm install` at the root (the `mcp` workspace is already declared in
   root `package.json`, so this links it and installs
   `@modelcontextprotocol/sdk`).
3. The MCP server imports server internals directly, e.g.
   `import { initDb } from '../../server/src/db.js'`. The server code has
   changed since commit `8fdfd1f` (new services, renamed exports are
   possible). Run `npm --workspace mcp run typecheck` and fix EVERY error.
   Rules for fixing:
   - If an import fails because a function was renamed in `server/src/`,
     update the `mcp/` import to the new name. NEVER rename anything in
     `server/src/` to satisfy `mcp/` — the server is the source of truth.
   - If a tool handler in `mcp/src/handlers.ts` calls a service function
     whose signature changed, adapt the handler's call site.
   - If a tool references a service that no longer exists, remove that single
     tool (both its definition and its handler case) and list every removed
     tool in the PR description.
4. Wire it into the root scripts if not already present (the root
   `package.json` already has `dev:mcp`; verify it works).
5. Add `mcp` to the root `typecheck` script so future CI catches drift:
   change the root `typecheck` script to also run
   `npm --workspace mcp run typecheck`.
   Do NOT add `mcp` to the root `build` or `test` scripts in this prompt
   (it has no tests yet and is not deployed by the compose stack).
6. Create `mcp/README.md` (it did not exist before) with: what the MCP server
   is, that it runs on stdio, how to start it
   (`npm --workspace mcp run dev`), and the fact that it imports
   `server/src/services/*` directly instead of going through HTTP.

Verification:

```bash
ls mcp/src
npm --workspace mcp run typecheck        # zero errors
npm run typecheck                        # root fan-out, includes mcp now
node --import tsx mcp/src/index.ts &     # should print "Dockyard MCP server running on stdio" to stderr
sleep 3; kill %1
```

(If the smoke-start fails because it needs a reachable Docker daemon or DB
file, that is acceptable — note the exact error in the PR description and
skip that single check. Typecheck must still pass unconditionally.)

### Step 6 — Add ESLint and Prettier

1. At the repo root, add dev dependencies (root only — flat config covers the
   workspaces): `eslint`, `@eslint/js`, `typescript-eslint`,
   `eslint-plugin-react-hooks`, `prettier`,
   `eslint-config-prettier`.
2. Create `eslint.config.mjs` at the root using ESLint flat config:
   - Base: `@eslint/js` recommended + `typescript-eslint` recommended
     (NOT the type-checked variants — they are too slow for this repo's CI
     right now and produce excessive noise on first adoption).
   - For `web/**/*.tsx` and `web/**/*.ts`: add `eslint-plugin-react-hooks`
     recommended rules.
   - Ignore: `**/dist/**`, `**/node_modules/**`, `data/**`,
     `scripts/issue-logs/**`, `web/dist/**`, `testing/**`.
   - Downgrade `@typescript-eslint/no-explicit-any` to `"warn"` (the codebase
     has existing `any`s; do not fix them in this prompt).
3. Create `.prettierrc.json` with: `{ "singleQuote": true, "printWidth": 100, "trailingComma": "all" }`
   and `.prettierignore` mirroring the ESLint ignores.
4. Add root scripts: `"lint": "eslint ."` and `"format": "prettier --write ."`
   and `"format:check": "prettier --check ."`.
5. Run `npm run lint`. You will get existing violations. Handle them in this
   exact priority order:
   a. Auto-fixable: run `eslint . --fix` and commit the mechanical changes as
      their own commit (`style(gap-00): eslint autofix`).
   b. Remaining **errors**: fix by hand ONLY if the fix is trivially safe
      (unused import, unreachable code). For anything requiring judgment,
      add a targeted `// eslint-disable-next-line <rule> -- TODO(gap-00)`
      comment instead of changing behavior. Count them in the PR description.
   c. Remaining **warnings**: leave them.
6. Do NOT run `prettier --write` across the whole repo in this prompt — a
   whole-repo reformat makes this PR unreviewable. Only add the config and
   scripts; formatting adoption is a human decision later. State this in the
   PR description.
7. Do NOT edit `.github/workflows/deploy.yml` to add a lint step — that file
   is protected and not authorized in this prompt. Instead, note in the PR
   description: "Follow-up: add `npm run lint` to the verify job."

Verification:

```bash
npm run lint                 # exits 0 (warnings allowed, errors not)
npm run typecheck            # still passes
npm test                     # still passes
```

## Things you must NOT do in this prompt

- Do not remove or downgrade `playwright`.
- Do not touch `docker-compose.yml`, `Dockerfile`, `Dockerfile.consumer`,
  `Caddyfile`, `scripts/issue-consumer.mjs`, or
  `.github/workflows/deploy.yml`.
- Do not reformat files wholesale.
- Do not upgrade any dependency versions (that is prompt 10).
- Do not rename anything in `server/src/`.

## Acceptance criteria (all must be true)

1. `grep '"deps"' package.json` finds nothing.
2. `bcryptjs`/`jsonwebtoken` live in `server/package.json`, not the root.
3. `git ls-files scripts/issue-logs` lists only `.gitkeep`; the log files
   still exist on disk.
4. `mcp/` exists, typechecks, and is included in root `npm run typecheck`.
5. `npm run lint` exists and exits 0.
6. `npm run typecheck` and `npm test` pass at the root.
7. The PR description lists: any removed MCP tools, any eslint-disable
   escape hatches added, and the two declared follow-ups (CI lint step,
   whole-repo format).

## Commit and push

Make one commit per step (six commits), messages like
`chore(gap-00): remove stray 'deps' dependency`. Then:

```bash
git push -u origin gap/00-repo-hygiene
```

Open a pull request titled
`chore: repo hygiene — stray dep, MCP restore, lint tooling, untracked logs`
and fill the description with the items required above.
