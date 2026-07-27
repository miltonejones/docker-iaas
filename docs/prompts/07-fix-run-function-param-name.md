# Fix: run_function reads `id` but schema says `functionId`

## Problem

The `run_function` tool schema defines the parameter as `functionId`, but the client dispatch in `AssistantBar.tsx` reads `input.id`. When Claude provides `functionId` (per the schema), `input.id` will be `undefined`, and `String(input.id ?? '')` becomes `''`. The call to `api.lambdaGetFunction('')` will fail.

## Location

- `server/src/tool-schemas.ts` line ~439 — parameter is `functionId`
- `web/src/components/AssistantBar.tsx` line ~1111 — reads `input.id`

## What to change

In `AssistantBar.tsx`, find the `case 'run_function':` block and change `input.id` to `input.functionId`:

```typescript
// Before
const functionId = String(input.id ?? '');

// After
const functionId = String(input.functionId ?? '');
```

Or alternatively, rename the schema parameter from `functionId` to `id` to match all the other lambda tools (`read_function`, `update_lambda_function`, `delete_lambda_function`) which use `id`.

## Verification

1. Ask the assistant to "Run function abc123" where abc123 is a real function ID
2. Verify the function ID is correctly passed through to the API call