# Fix: MCP GitHub tools use wrong parameter names

## Problem

The `GITHUB_TOOLS` in `tool-schemas.ts` use `repo` (in `owner/repo` format) and `branch`, but the actual GitHub handler functions (`pullGithubRepoToBucket`, `pullGithubRepoToContainer`, `commitAndPushGithubFiles`) expect `owner`, `repo`, and `ref` as separate parameters. The MCP handler passes `args` directly to these functions, so parameter names must match.

The assistant path works correctly because `GITHUB_ASSISTANT_TOOLS` uses `owner`, `repo`, and `ref`, and those tools are excluded from `COMMON_TOOL_SCHEMAS` via `SEPARATE_MODULE_NAMES`. But the MCP server uses the common schemas, which have the wrong parameter names.

## Location

- `server/src/tool-schemas.ts` — `GITHUB_TOOLS` section (around line 720-760)
- `mcp/src/handlers.ts` — lines where GitHub tools call `pullGithubRepoToBucket(args)`, etc.

## What to change

In `tool-schemas.ts`, update each GitHub tool's `properties` to use `owner`, `repo`, and `ref` instead of `repo` and `branch`:

### `list_github_repo_files`

```typescript
// Before
repo: { type: 'string', description: 'Repository in owner/repo format' },
branch: { type: 'string', description: 'Branch or ref' },

// After
owner: { type: 'string', description: 'Repository owner' },
repo: { type: 'string', description: 'Repository name' },
ref: { type: 'string', description: 'Git ref (branch, tag, or commit SHA)' },
```

### `read_github_file`

Same change as above.

### `pull_github_repo_to_bucket`

Same change as above, plus add `bucket`, `prefix`, `clean` parameters.

### `pull_github_repo_to_container`

Same change as above, plus add `id`, `path`, `clean` parameters.

### `commit_and_push_github_files`

Change `branch` to `ref`, keep `owner`, `repo`, add `message` and `files`.

### Also: Add `get_github_workflow_status` to common schemas

This tool exists only in `GITHUB_ASSISTANT_TOOLS` but not in `GITHUB_TOOLS`. The MCP server cannot expose it. Add it to `GITHUB_TOOLS` in `tool-schemas.ts` and add a handler case in `mcp/src/handlers.ts`.

## Verification

1. Build the MCP server
2. Test `list_github_repo_files` with `owner` and `repo` as separate parameters
3. Verify the GitHub functions receive the correct parameters