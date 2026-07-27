# Fix: missing await on systemService.usedPorts()

## Problem

In `server/src/routes/assistant.ts`, the `list_used_ports` case calls `systemService.usedPorts()` without `await`:

```typescript
case "list_used_ports":
  return systemService.usedPorts();  // missing await
```

`usedPorts()` is an async function that returns `Promise<{ ports: number[] }>`. Every other async call in the same switch statement uses `await`. This works due to JavaScript Promise flattening in async functions, but it's inconsistent and could cause issues if error handling or post-processing is added later.

## Location

`server/src/routes/assistant.ts` — the `list_used_ports` case in `executeReadOnlyTool` (around line 261).

## What to change

Add `await`:

```typescript
case "list_used_ports":
  return await systemService.usedPorts();
```

## Verification

1. Start the dev server
2. Open the assistant and ask "What ports are in use?"
3. Verify `list_used_ports` returns port data correctly