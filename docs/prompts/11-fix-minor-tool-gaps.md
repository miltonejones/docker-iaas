# Fix: Minor assistant tool gaps

## 1. `report_issue` — `details` type mismatch

**Problem:** The schema declares `details` as `{ type: 'string' }`, but the API expects `details` as `Record<string, unknown>` (an object). The client dispatch casts `input.details as Record<string, unknown> | undefined`. When Claude sends a string, it gets coerced or lost.

**Fix:** Change the schema type from `string` to `object`:

```typescript
details: { type: 'object', description: 'Structured details about the issue' },
```

## 2. `update_issue` — missing `resolution` and `resolvedBy` parameters

**Problem:** The schema declares `issueId`, `summary`, `status`, `details`. But the client dispatch sends `{ status, resolution, resolvedBy }`. `resolution` and `resolvedBy` are not in the schema, so Claude can never set a resolution. `details` is in the schema but never sent by the client.

**Fix:** Add `resolution` and `resolvedBy` to the schema, remove `details` (or keep it as optional):

```typescript
{
  name: 'update_issue',
  ...
  properties: {
    issueId: { type: 'string', description: 'Issue ID' },
    status: { type: 'string', enum: ['open', 'resolved', 'wontfix'], description: 'New status' },
    resolution: { type: 'string', description: 'Resolution description' },
    resolvedBy: { type: 'string', description: 'Who resolved the issue' },
  },
  required: ['issueId'],
},
```

## 3. `create_lambda_function` and `update_lambda_function` — missing `description`

**Problem:** The schemas in `tool-schemas.ts` advertise `description` as a parameter, but the client dispatch in `AssistantBar.tsx` doesn't pass `description` to `api.lambdaCreateFunction()` or `api.lambdaUpdateFunction()`.

**Fix:** Add `description` to the dispatch calls:

```typescript
// create_lambda_function (line ~884)
api.lambdaCreateFunction(
  String(input.name ?? ''),
  String(input.runtime ?? 'node'),
  String(input.code ?? ''),
  str(input.packages),
  str(input.entryPoint),
  parseLambdaFiles(input.files),
  str(input.projectId),
  // MISSING: str(input.description),  ← need to check if API accepts it
);
```

Check whether `api.lambdaCreateFunction` and `api.lambdaUpdateFunction` accept a `description` parameter. If they do, add it. If not, remove it from the schema.

## 4. `autoStart` hardcoded to `true` in `launch_container`

Already covered in prompt #01.

## 5. Section comment stale

`tool-schemas.ts` line 530 says `// ── Databases (12) ──` but there are 16 database tools. Update to `(16)`.

## 6. `delete_database_connection` and `restore_database_backup` missing from DESTRUCTIVE set

The `DESTRUCTIVE` set in `AssistantBar.tsx` (lines 144-155) lists tools that should show a stronger warning. `delete_database_connection` and `restore_database_backup` are arguably destructive but are missing from this set.

## 7. `test_database_connection` not in READ_ONLY_TOOLS

This tool tests a connection and persists the health status. It's borderline (minor side effect), but it's inconvenient to require confirmation for a test. Consider adding it to `READ_ONLY_TOOLS` and adding a case in `executeReadOnlyTool` that calls `databaseService.testConnection()`.