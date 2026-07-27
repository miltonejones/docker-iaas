# Fix: system_ping and list_volumes missing from READ_ONLY_TOOLS

## Problem

`system_ping` and `list_volumes` are semantically read-only operations, but they are missing from the `READ_ONLY_TOOLS` set in `server/src/routes/assistant.ts`. This means every time the assistant calls either tool, the user is forced to confirm a trivial read-only operation.

Additionally, neither tool has a case in the `executeReadOnlyTool` switch statement, so even adding them to `READ_ONLY_TOOLS` alone won't work — they'd hit the `default` branch which throws `"Unknown read-only tool"`.

## Location

`server/src/routes/assistant.ts`

## What to change

### Step 1: Add to READ_ONLY_TOOLS set

Find the `READ_ONLY_TOOLS` set (around line 155) and add `system_ping` and `list_volumes`:

```typescript
const READ_ONLY_TOOLS = new Set([
  "list_containers",
  "list_functions",
  // ... existing entries ...
  "list_projects",
  "system_ping",       // ← ADD
  "list_volumes",      // ← ADD
  ...DATABASE_ASSISTANT_READ_ONLY_TOOLS,
  ...GITHUB_ASSISTANT_READ_ONLY_TOOLS,
]);
```

### Step 2: Add switch cases in executeReadOnlyTool

Find the `executeReadOnlyTool` function's switch statement (around line 200) and add cases:

```typescript
case "system_ping": {
  return systemService.ping();
}

case "list_volumes": {
  return volumeService.list();
}
```

### Step 3: Add import

Make sure `volumeService` is imported at the top of the file. `systemService` should already be imported.

```typescript
import * as volumeService from '../services/volumes.js';
```

## Verification

1. Start the dev server
2. Open the assistant and ask "Is Docker running?" — this should trigger `system_ping`
3. Verify it executes immediately without asking for confirmation
4. Ask "List all Docker volumes" — this should trigger `list_volumes`
5. Verify it executes immediately without asking for confirmation