# Fix: replace_lambda_function_files missing `entryPoint` in schema

## Problem

The `replace_lambda_function_files` tool schema (in `assistant-tools.ts`) declares only `id` and `files` as properties, but the client dispatch requires `entryPoint` — it throws `"Function files must include the entry point."` if no file matches the entry point.

Since `entryPoint` is not in the schema, Claude will never provide it. The dispatch reads `String(input.entryPoint ?? '')` which yields `''`. The fallback search for a file with `path === ''` will fail, and the tool throws an error. This tool is completely unusable.

## Location

- `server/src/assistant-tools.ts` line ~282-300 — schema defines `id` and `files` but not `entryPoint`
- `web/src/components/AssistantBar.tsx` line ~906-917 — dispatch reads `input.entryPoint` and requires it

## What to change

Add `entryPoint` to the schema in `assistant-tools.ts`:

```typescript
{
  name: 'replace_lambda_function_files',
  description: 'Replace all files in a Lambda function. Must include the entry point file.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Function ID' },
      entryPoint: { type: 'string', description: 'Entry point filename (e.g. "index.js")' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path within the function' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['path', 'content'],
        },
        description: 'Array of files to replace',
      },
    },
    required: ['id', 'files'],
  },
},
```

## Verification

1. Ask the assistant to replace files in a lambda function
2. Verify the `entryPoint` is provided in the pending action
3. Confirm the function files are successfully updated