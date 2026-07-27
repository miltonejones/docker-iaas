# Fix: MCP database tools are broken (skeletal schemas + missing config object)

## Problem

The MCP server uses `COMMON_TOOL_SCHEMAS` for tool definitions, which includes skeletal `DATABASE_TOOLS` with incomplete parameters. The assistant uses the richer `DATABASE_ASSISTANT_TOOLS` (which are excluded from `buildAssistantTools` via `SEPARATE_MODULE_NAMES`), so the assistant works fine. But the MCP server's database tools are broken or severely limited:

### Critically broken (will crash or return errors)

1. **`run_database_read_query`** — Schema only has `connectionId`. Missing `sql`, `collection`, `mode`, `filter`, `projection`, `sort`, `limit`, `pipeline`. Without these, the tool cannot execute any query.

2. **`execute_database_mutation`** — Schema only has `connectionId` and `confirmed`. Missing `statement`, `operation`, `collection`, `document`, `documents`, `filter`, `update`, `upsert`. No mutation can be formed.

3. **`execute_database_migration`** — Schema only has `connectionId` and `confirmed`. Missing `statements` and `steps`. No migration can be formed.

4. **`create_database_connection`** — Schema uses flat fields (`host`, `port`, `database`, `username`, `password`). The handler passes args through to `normalizeConnectionInput()` which requires a `config` object. An MCP client sending flat fields will get an error like `"config must be a plain object"`.

5. **`update_database_connection`** — Same problem. Handler requires `config` object but schema advertises flat fields.

### Parameter name mismatches (inconsistent but works via MCP handler)

6. **`get_database_connection`** — Schema uses `id`; handler uses `args.id`. Works but inconsistent with assistant's `connectionId`.

7. **`inspect_database_schema`** — Same: schema `id` vs assistant `connectionId`.

8. **`test_database_connection`** — Same.

9. **`delete_database_connection`** — Same.

10. **`get_database_job`** — Schema uses `id`; assistant uses `jobId`.

### Missing parameters (limiting but not crashing)

11. **`execute_database_access_grant`** — Missing `host` (MySQL), `withGrantOption` (MySQL), `authDatabase` (MongoDB), `roles` (MongoDB). MySQL grants may partially work; MongoDB grants are non-functional.

## Location

- `server/src/tool-schemas.ts` lines 530-669 — `DATABASE_TOOLS` section
- `mcp/src/handlers.ts` — MCP handler dispatch
- `mcp/src/tools.ts` — `COMMON_TOOL_SCHEMAS.map(toMcpSchema)` produces the broken schemas

## What to change

The fix is to replace the skeletal `DATABASE_TOOLS` in `tool-schemas.ts` with schemas that match the richer `DATABASE_ASSISTANT_TOOLS` format. Since database tools are already excluded from `buildAssistantTools` via `SEPARATE_MODULE_NAMES`, the assistant is unaffected — only the MCP server benefits.

### For each database tool in `tool-schemas.ts`:

Copy the `input_schema` from the corresponding tool in `databaseAssistantTools.ts` and convert it to the `ToolSchema` format (using `properties` + `required` instead of `input_schema`).

Key conversions needed:
- `connectionId` → keep as `connectionId` (not `id`) for consistency
- Add the nested `config` object for `create_database_connection` and `update_database_connection`
- Add `sql`, `collection`, `mode`, `filter`, etc. to `run_database_read_query`
- Add `statement`, `operation`, etc. to `execute_database_mutation`
- Add `statements`, `steps` to `execute_database_migration`
- Add `host`, `withGrantOption`, `authDatabase`, `roles` to `execute_database_access_grant`

### For the MCP handler:

The handler at `mcp/src/handlers.ts` already passes `args` through to the service functions, so once the schemas are correct, the parameters will flow through. However, for `create_database_connection` and `update_database_connection`, the handler must wrap flat fields into a `config` object if the MCP client sends them that way. The cleanest fix is to make the schemas match the service's expected format (with `config` object), so the handler can pass args directly.

## Verification

1. Build the MCP server: `cd mcp && npm run build`
2. Connect via an MCP client
3. Test `run_database_read_query` with a real connection ID and SQL query
4. Test `create_database_connection` with a `config` object
5. Verify the schemas match what the service functions actually accept