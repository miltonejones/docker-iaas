# Fix: launch_container drops volumes, projectId, and hardcodes autoStart

## Problem

In `web/src/components/AssistantBar.tsx`, the `launch_container` case in the `runAction` switch silently drops three parameters that the tool schema advertises:

- **`volumes`**: Volume mounts like `"mydata:/app/data"` are never forwarded. Containers are created without persistent storage.
- **`projectId`**: Containers launched via the assistant can never be assigned to a project, even though the tool description says "Project to associate this container with".
- **`autoStart`**: Hardcoded to `true`. The assistant cannot create a stopped container — `autoStart: false` is ignored despite the tool description saying "Set autoStart to false to create but not start."

## Location

`web/src/components/AssistantBar.tsx` — the `launch_container` case in the `runAction` function (around line 962).

## What to change

Find the `case 'launch_container':` block. The current code looks like:

```typescript
return api.launch({
  presetId: str(input.presetId),
  image: str(input.image),
  name: str(input.name),
  description: str(input.description),
  protected: bool(input.protected),
  command: ...,
  ports: ...,
  env: ...,
  autoStart: true,        // ← HARDCODED
  assistantManaged: true,
  // ← MISSING: volumes
  // ← MISSING: projectId
});
```

Change it to:

```typescript
return api.launch({
  presetId: str(input.presetId),
  image: str(input.image),
  name: str(input.name),
  description: str(input.description),
  protected: bool(input.protected),
  command: ...,
  ports: ...,
  env: ...,
  volumes: Array.isArray(input.volumes) ? input.volumes as string[] : undefined,
  autoStart: input.autoStart !== false,   // default true, respect explicit false
  projectId: str(input.projectId) || undefined,
  assistantManaged: true,
});
```

## Verification

1. Start the dev server
2. Open the assistant and ask it to "Launch a container with a volume mount"
3. Verify the `volumes` field appears in the pending action and is forwarded to the API
4. Ask it to "Create a container in project X but don't start it"
5. Verify `projectId` and `autoStart: false` are forwarded