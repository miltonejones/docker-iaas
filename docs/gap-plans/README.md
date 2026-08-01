# Dockyard Gap-Closure Plan — Prompt Library

This directory contains **13 implementation prompts** (numbered `00` through `12`).
Each file is a complete, self-contained prompt intended to be handed to an LLM
(such as the Dockyard issue consumer, Claude Code, or any coding agent) as the
**entire task description** for one unit of work.

These prompts were produced from a project evaluation performed on 2026-08-01.
They close the gaps identified in that evaluation. Prompts 11 and 12 come
from a follow-up deep review of the assistant subsystem (chat pipeline and
user-created custom assistants) on the same date.

---

## How to use this library

1. **One prompt = one task = one branch = one pull request.** Never give an LLM
   two of these prompts at once. Never combine two prompts into one branch.
2. **Feed the entire file** to the LLM, verbatim, as its instructions. Every
   file repeats the global rules below because the LLM may only ever see that
   one file. That repetition is intentional — do not "deduplicate" it.
3. **Run the prompts in numerical order where dependencies exist.** The
   dependency graph is listed below. Prompts with no dependency arrows between
   them may be run in any order or in parallel on separate branches.
4. **A human must review every pull request** produced from these prompts
   before merge. Several prompts touch security-sensitive code (auth, CI,
   Docker). None of them should be merged by an automated process.

## Execution order and dependencies

| # | File | Title | Depends on |
|---|------|-------|-----------|
| 00 | `00-repo-hygiene-and-tooling.md` | Repo hygiene: stray dependency, MCP workspace restore, ESLint/Prettier, untracked artifacts | — (run FIRST) |
| 01 | `01-rbac-multi-user.md` | Role-based access control (admin / operator / viewer) | 00 |
| 02 | `02-container-stats-streaming.md` | Live CPU / memory stats for containers | 00 |
| 03 | `03-volume-management-ui.md` | Volume management page in the web UI | 00 |
| 04 | `04-rate-limiting-and-audit-alerts.md` | Rate limiting, login throttling, audit alerting | 00 |
| 05 | `05-dockyard-self-backup.md` | Backup/restore of Dockyard's own state (SQLite + MinIO) | 00 |
| 06 | `06-ci-rollback.md` | Automatic rollback to last good image on failed deploy | 00 |
| 07 | `07-e2e-docker-integration-tests.md` | End-to-end integration tests against a real Docker daemon | 00 (and ideally after 02, 03 so their endpoints get covered) |
| 08 | `08-structured-logging.md` | Structured JSON logging with request/issue correlation IDs | 00 |
| 09 | `09-protected-files-hard-enforcement.md` | Hard (non-prompt) enforcement of the protected-files list | 00 |
| 10 | `10-dependency-updates.md` | Dependabot configuration and dependency update policy | 00 |
| 11 | `11-assistant-security-fixes.md` | Assistant security: session ownership (IDOR), scoped tool reads, fail-closed custom assistants | 00 (and 00's `mcp/` restore for one optional sub-step) |
| 12 | `12-custom-assistant-workflow.md` | Custom-assistant workflow: prompt composition, tool-picker integrity, @name routing, dead features | 11 (hard dependency — do not start 12 before 11 is merged) |

Recommended sequence for a single worker: `00 → 11 → 04 → 09 → 12 → 08 → 07 →
06 → 01 → 05 → 02 → 03 → 10`. Security and safety-net items first, features
after. Prompt 11 ranks immediately after 00 because it fixes live
cross-user defects (session IDOR, unscoped resource listing in chat).

## Global rules (repeated inside every prompt)

These rules bind every prompt in this directory:

- **Protected files.** The file `scripts/protected-files.json` lists files the
  autonomous issue consumer must never edit:
  `Dockerfile.consumer`, `docker-compose.yml`, `docker-compose.ci.yml`,
  `Caddyfile`, `.gitignore`, `.github/workflows/deploy.yml`,
  `scripts/issue-consumer.mjs`, `scripts/protected-files.json`,
  `scripts/smoke-test-hardening.sh`.
  Some prompts here *do* require edits to those files (for example prompt 06
  edits the deploy workflow). That is only permitted because these prompts are
  executed deliberately by a human-supervised agent on a reviewed branch —
  **never** by the autonomous consumer reacting to a filed issue. Each prompt
  states explicitly which protected files it may touch. If a protected file is
  not named in the prompt, do not touch it.
- **Do not remove Playwright.** `playwright` in `server/package.json` is a
  required production dependency (it powers preview/screenshot endpoints).
  No prompt in this library removes it. If you believe it is unused, you are
  wrong — leave it alone and say so in your PR description instead.
- **Verification is mandatory.** Every prompt ends with a Verification section
  listing exact commands. Run every command. If any fails, fix the failure
  before committing. Do not commit failing code and describe it as done.
- **Branch naming**: `gap/<two-digit-number>-<short-slug>`, e.g.
  `gap/04-rate-limiting`.
- **Commit messages**: conventional style, e.g.
  `feat(gap-04): add rate limiting to auth and API routes`, followed by a body
  explaining *what* and *why*.
- **Never push to `main` directly.** Push the branch, open a pull request.
- **Never force-push.**

## Repository facts (context for all prompts)

- Node 22, npm workspaces monorepo. Declared workspaces: `server`, `web`,
  `relay`, `mcp` (the `mcp` directory is restored by prompt 00).
- `server/` — Express + dockerode REST API, TypeScript, ESM
  (`"type": "module"`), better-sqlite3, tests via
  `node --import tsx --test src/*.test.ts src/**/*.test.ts`.
- `web/` — React 18 + Vite + vitest.
- `relay/` — small WebSocket relay, same toolchain as server.
- Root scripts: `npm run typecheck`, `npm test`, `npm run build` fan out to
  workspaces.
- CI: `.github/workflows/deploy.yml` — verify (typecheck + test) → smoke test →
  build/push images to GHCR (arm64) → SSH deploy to EC2.
- The server binds `0.0.0.0:4300`; compose publishes it on `127.0.0.1:4300`
  and Caddy fronts it on 80/443.
- Auth: JWT (`server/src/auth.ts`), users in SQLite, `requireAuth` /
  `optionalAuth` / `webhookAuth` middleware.
