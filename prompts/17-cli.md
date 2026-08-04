# Dockyard CLI

Give Dockyard a real terminal/scripting interface — a `dockyard` command
backed by the same REST API and API-key auth as the web console, using
Dockyard's own vocabulary rather than a second one borrowed from AWS.

## Context

Everything Dockyard can do today requires either the web console or Ask
Dockyard's browser-based assistant — there's no way to manage it from a
script or a CI pipeline. This gap adds a new `cli` npm workspace: a small
Node CLI that talks to the existing REST API (`server/src/routes/*`) using
the `dky_`-prefixed API keys added in [[16-api-key-auth]] (a hard
prerequisite — the CLI has nothing to authenticate with otherwise).

This is deliberately scoped as "a thin, authenticated HTTP client of the
existing API," not a new integration surface. Ask Dockyard's assistant, the
web console, and (per [[18-mcp-rest-client]]) MCP already give this
codebase a repeated pain point: every new capability needs wiring into
multiple independent surfaces that can silently drift out of sync (see
gap/14's plan.md, which named this "three wiring surfaces, not one"). The
CLI avoids becoming a fourth by never touching the service layer directly —
every command is exactly one HTTP call to a route that already exists.

## Reasoning / design decisions

- **Dockyard-native vocabulary, not AWS-CLI-mirroring** (confirmed with the
  user). `dockyard <resource> <verb>` maps 1:1 onto the tool names already
  established in `server/src/tool-schemas.ts` and used throughout the web
  console and assistant (`list_containers` → `dockyard container list`,
  `create_bucket` → `dockyard bucket create`). Considered mirroring the real
  `aws` CLI's verbs (`dockyard s3 ls`) to trade on muscle memory given
  Dockyard's AWS-parity mission — rejected because the parity goal is about
  *resource/event shapes* matching AWS (see the lambda-gateway proxy
  integration precedent), not CLI ergonomics, and introducing a second
  vocabulary alongside the one every other surface already uses would be
  the "translation layer" this codebase has explicitly chosen to avoid
  elsewhere.
- **`node:util`'s built-in `parseArgs`, not a dependency, and not fully
  hand-rolled either.** Every existing workspace here (`server`, `mcp`,
  `relay`) is deliberately dependency-light — `mcp/package.json` has exactly
  one runtime dependency, the SDK it can't avoid. Truly hand-rolling flag
  parsing (splitting on `--`/`=`, tracking which flags repeat, negating
  booleans) is a worse trade than it first looks: `--flag=value` vs
  `--flag value`, and `--no-foo`-style boolean negation, are real parsing
  rules a naive `argv.forEach` gets wrong at the edges, and are exactly what
  `util.parseArgs` (stable since Node 18.3, zero install cost — it's part of
  the runtime) already implements correctly. (Quoted values with spaces,
  e.g. `dockyard bucket create "my bucket"`, are NOT something the parser
  needs to handle — the shell has already tokenized `argv` into one element
  by the time Node sees it.) Each command file declares its own
  `parseArgs` `options` schema (`{ image: { type: 'string' }, port: { type:
  'string', multiple: true }, force: { type: 'boolean' } }`), so per-command
  flags stay self-documenting without adding a framework dependency.
  `commander`/`yargs` remain out of scope — the win they'd add on top of
  `parseArgs` is subcommand help text/shell completions, not correctness,
  and v1 doesn't need those yet.
- **A dedicated `request()` helper, not a reuse of `web/src/api.ts`.**
  `web/src/api.ts` injects auth by monkey-patching the *global* `fetch` —
  correct for a browser SPA with one implicit session, wrong for a CLI/
  library context (global mutable state, surprising side effects for
  anything else in the same process). The CLI gets its own small, explicit
  `request(config, method, path, body)` function that takes its config as a
  parameter — same conventions (bearer header, `{error}` body → thrown
  `Error`) so error messages match what the web console shows for the same
  failure, but no global patching.
- **Zero runtime dependencies — global `fetch`, intentionally.** `cli/`
  ships with no `dependencies`, only `devDependencies` (tsx/typescript/
  @types/node). This relies on Node's built-in global `fetch` (stable since
  Node 18) and `util.parseArgs` (stable since Node 18.3). This repo's dev
  environment runs Node 20.19.4, comfortably past both thresholds, so this
  is a deliberate choice, not an oversight — add `"engines": { "node":
  ">=18.3.0" }` to `cli/package.json` so an install on an older Node fails
  fast with a clear message instead of a confusing runtime error the first
  time `fetch`/`parseArgs` is called.
- **XDG config path (`~/.config/dockyard/config.json`), not a bespoke
  dotfolder.** No existing precedent in this repo pulls either way (no prior
  CLI); XDG is the more standard modern convention (`gh`, and most
  actively-maintained dev CLIs, follow it) and keeps `$HOME` tidier than a
  new top-level dotfolder. Respect `$XDG_CONFIG_HOME` if set.
- **The CLI consumes an already-issued API key; it does not do its own
  username/password login.** `dockyard login` prompts for `apiUrl` + a
  pasted `apiKey` (minted via [[16-api-key-auth]]'s Settings panel or a
  direct `POST /api/api-keys` call), validates it against `GET /api/auth/me`
  before saving, then stores it. This keeps the CLI's auth surface identical
  in shape to what [[18-mcp-rest-client]] will use, and avoids needing to
  handle password/bcrypt flows in a third place.
- **Human-readable output by default, `--json` for scripting.** Matches
  `docker`/`aws`/`gh` conventions and this repo's stated audience for the
  CLI (developers scripting CI/CD): interactive use gets readable tables,
  automation opts into raw JSON explicitly rather than the reverse.

## v1 command surface

Curated subset — the five highest-value resource groups for a
scripting/CI audience. Each row is one REST call, using the exact route
that `web/src/api.ts` and the assistant already use for the same tool name.

| Resource | Verb | Underlying tool / route | Notes |
|---|---|---|---|
| `container` | `list` | `list_containers` | `--project <id>` optional |
| `container` | `launch` | `launch_container` | `--image`, `--name`, `--port host:container` (repeatable), `--env KEY=VALUE` (repeatable) |
| `container` | `inspect` | `inspect_container` | positional `<id>` |
| `container` | `start`/`stop`/`restart` | `container_action` | positional `<id>`; verb maps to the `action` field |
| `container` | `logs` | `get_container_logs` | positional `<id>`, `--tail <n>` |
| `container` | `delete` | `delete_container` | positional `<id>`, `--force` |
| `bucket` | `list` | `list_buckets` | |
| `bucket` | `create` | `create_bucket` | positional `<name>`, `--protected` |
| `bucket` | `delete` | `delete_bucket` | positional `<name>` |
| `function` | `list` | `list_functions` | CLI noun is "function" even though some existing tool names say "lambda" — normalize display, keep calling the real tool/route underneath |
| `function` | `create` | `create_lambda_function` | `--name`, `--runtime`, `--code @path/to/file` (CLI is the first caller that reads code from a local file rather than passing it inline) |
| `function` | `run` | `run_function` | `--id <functionId>`, `--payload <json>` |
| `function` | `delete` | `delete_lambda_function` | positional `<id>` |
| `route` | `list` | `list_gateway_routes` | |
| `route` | `create` | `create_gateway_route` | flags per the existing tool's schema (`--domain`, `--target-type`, `--target-id`, `--target-port`, `--method`, `--path-pattern`) |
| `route` | `delete` | (confirm exact name in `GATEWAY_TOOLS`) | positional `<id>` |
| `project` | `list` | `list_projects` | |
| `project` | `create` | `create_project` | `--name`, `--description` |
| `project` | `delete` | `delete_project` | positional `<id>` |

Explicitly deferred, not v1: images, volumes, host-files, host-builds,
databases, GitHub tools, system tools. Add these later using the exact same
pattern — no new mechanism needed, just another row in the table above and
one command file.

## Implementation steps

### 1. Workspace scaffold

Add `"cli"` to root `package.json`'s `workspaces` array and to the
`typecheck` script chain (currently
`server && web && relay && mcp` → append `&& npm --workspace cli run typecheck`).

`cli/package.json`, shaped like `mcp/package.json`:

```json
{
  "name": "dockyard-cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "dockyard": "./dist/index.js" },
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": { "tsx": "^4.16.2", "typescript": "^5.5.3", "@types/node": "^20.14.9" }
}
```

`cli/tsconfig.json`: same shape as `mcp/tsconfig.json`. `src/index.ts`
starts with `#!/usr/bin/env node` (passes through `tsc` untouched as a
leading comment — verify this during implementation and `chmod +x` the
build output if needed).

### 2. HTTP client — `cli/src/client.ts`

```ts
export interface DockyardClientConfig { apiUrl: string; apiKey: string; }

export async function request<T>(
  config: DockyardClientConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}
```

### 3. Config — `cli/src/config.ts`

- Path: `path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dockyard', 'config.json')`.
- `loadConfig()`/`saveConfig()` — `saveConfig` writes with `{ mode: 0o600 }`
  since the file holds a live bearer credential.
- `resolveConfig()` — env vars `DOCKYARD_API_URL`/`DOCKYARD_API_KEY` override
  the file, for CI use; falls back to the file; throws a clear "run
  `dockyard login` first" error if neither is present.
- `dockyard login` (primary verb) / `dockyard configure` (documented alias):
  prompt for `apiUrl` (default `http://localhost:4300`) and `apiKey`,
  validate via `GET /api/auth/me` before saving.
- `dockyard logout`: deletes the config file.

### 4. Argument parsing + dispatch — `cli/src/index.ts`, `cli/src/parse.ts`

**Dispatch is two-tier, not a flat `resource/verb` map** — `login`,
`logout`, and `configure` are top-level verbs, not a resource, and need to
be checked *before* falling into resource/verb dispatch:

```ts
const SPECIAL_COMMANDS = new Set(['login', 'logout', 'configure', 'help', '--help', '-h']);

const [first, second, ...rest] = process.argv.slice(2);

if (!first || SPECIAL_COMMANDS.has(first)) {
  await runSpecialCommand(first, rest); // login/logout/configure/help — no resource/verb shape
} else {
  const resource = first;
  const verb = second;
  await runResourceCommand(resource, verb, rest); // container/bucket/function/route/project
}
```

- `runResourceCommand` looks up `commands[resource][verb]` (404s with a
  clear "unknown resource/verb" message if either lookup misses) and hands
  it the remaining `rest` args to parse with `node:util`'s `parseArgs`.
- Each command file under `cli/src/commands/` (`container.ts`, `bucket.ts`,
  `function.ts`, `route.ts`, `project.ts`) exports a
  `{ [verb]: { options: ParseArgsOptionsConfig, run(client, parsed) => Promise<unknown> } }`
  map — `options` is passed straight to `parseArgs({ args: rest, options,
  allowPositionals: true })`, so each verb declares its own flags/positionals
  schema instead of hand-parsing them.
- The global `--json` flag is handled once, centrally, in `index.ts` (stripped
  from `rest` before it reaches a command's own `parseArgs` call) — it
  controls output formatting only, never reaches a command's `run()`.

### 5. Output formatting — `cli/src/output.ts`

- Default: column-aligned table (manual `padEnd`, no table-rendering
  dependency). **Explicit truncation convention, so it doesn't break on long
  values**: each column has a max width of 40 characters; any cell longer
  than that is truncated to 37 chars + `…`. Column width is otherwise
  `min(40, longest value in that column)`, so short columns (e.g. `STATE`)
  don't get padded out to 40 chars for no reason. `--json` bypasses this
  entirely — full untruncated data, since that's the scripting path where
  truncation would silently corrupt output.
- `--json`: `console.log(JSON.stringify(data, null, 2))`.
- Errors go to `stderr`, process exits non-zero — required for CI script
  chains (`&&`, `set -e`) to behave correctly.

## Files summary

| File | Change |
|---|---|
| `package.json` (root) | Add `cli` to `workspaces` + `typecheck` chain |
| `cli/package.json` | New |
| `cli/tsconfig.json` | New |
| `cli/src/index.ts` | New — entrypoint, dispatch |
| `cli/src/client.ts` | New — HTTP client |
| `cli/src/config.ts` | New — XDG config, `login`/`logout` |
| `cli/src/parse.ts` | New — arg parsing |
| `cli/src/output.ts` | New — table/JSON formatting |
| `cli/src/commands/container.ts` | New |
| `cli/src/commands/bucket.ts` | New |
| `cli/src/commands/function.ts` | New |
| `cli/src/commands/route.ts` | New |
| `cli/src/commands/project.ts` | New |

## Constraints

- Do NOT add a CLI-framework dependency (`commander`, `yargs`, etc.) for v1
  — `node:util`'s built-in `parseArgs` per the reasoning above. Revisit only
  if the surface grows enough to need real subcommand help/completions.
- Do NOT let `cli/src/index.ts`'s dispatch treat `login`/`logout`/
  `configure` as a `resource`/`verb` pair — they're special top-level
  commands, handled before resource/verb lookup (see step 4).
- Do NOT reuse `web/src/api.ts`'s global-fetch-patching approach.
- Do NOT try to cover all ~12 `tool-schemas.ts` resource groups in v1 —
  ship the five listed above; add more later via the same pattern.
- Match the existing workspace conventions (ESM, `tsx` for dev, `tsc` for
  build) rather than introducing a different build tool.
- Run `npm run typecheck` (including the new `cli` chain entry) after
  changes.

## Testing plan

Manual, against a throwaway dev instance (repo's standing protocol — real
shared SQLite/Docker/MinIO, clean up test data afterward):

1. Obtain a test API key via [[16-api-key-auth]]'s endpoint/UI.
2. `dockyard login` (or set `DOCKYARD_API_URL`/`DOCKYARD_API_KEY` env vars)
   — confirm the config file is written with `0600` perms and the
   `GET /api/auth/me` validation succeeds.
3. `dockyard container list` — confirm table output matches a direct
   `curl /api/containers` call.
4. `dockyard container list --json` — confirm the raw JSON matches the
   curl response.
5. `dockyard bucket create test-cli-bucket` → `dockyard bucket list` →
   `dockyard bucket delete test-cli-bucket` — full round trip, cleaned up.
6. `dockyard function create --name test-cli-fn --runtime node --code @fixture.js`
   → `dockyard function run --id <id>` → `dockyard function delete <id>` —
   cleaned up.
7. Negative case: run any command with a revoked/bogus key — confirm a
   clear one-line error on stderr and non-zero exit, not a stack trace.
8. `npm --workspace cli run typecheck`.
