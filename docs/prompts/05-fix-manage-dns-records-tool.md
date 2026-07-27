# Fix: manage_dns_records tool is completely broken

## Problem

The `manage_dns_records` tool has a critical mismatch between its schema, its client-side dispatch, and read-only handling. **DNS management is completely non-functional through the assistant** — every possible action value either doesn't match the schema or doesn't match the client dispatch.

### Schema says:
```json
{
  "name": "manage_dns_records",
  "action": { "enum": ["create", "delete"] },
  "zoneId": { "type": "string" },
  "name": { "type": "string" }
}
```

### Client dispatch (`AssistantBar.tsx` line 953-960) expects:
```typescript
case 'manage_dns_records': {
  const act = String(input.action ?? '');
  if (act === 'list_zones') return api.dnsListZones();
  if (act === 'list_records') return api.dnsListRecords(zoneId, name);
  if (act === 'create_cname') return api.dnsCreateRecord(zoneId, act, name);
  if (act === 'delete_record') return api.dnsDeleteRecord(zoneId, name);
  throw new Error(`Unknown DNS action: ${act}`);
}
```

### What breaks:
1. **`list_zones`** — Read-only action. Schema doesn't include it in the enum. Model can't express it. Should be auto-resolved (read-only).
2. **`list_records`** — Read-only action. Same problem. Should be auto-resolved (read-only).
3. **`create`** — Schema allows this value, but client expects `create_cname`. Passing `action: "create"` hits the `throw new Error` fallback.
4. **`delete`** — Schema allows this value, but client expects `delete_record`. Passing `action: "delete"` hits the `throw new Error` fallback.

## Location

- `server/src/tool-schemas.ts` — the `manage_dns_records` tool definition (line 353)
- `server/src/assistant-tools.ts` — the description overlay (line 25)
- `server/src/routes/assistant.ts` — needs `list_zones` and `list_records` in `READ_ONLY_TOOLS` and `executeReadOnlyTool`
- `web/src/components/AssistantBar.tsx` — the dispatch (line 953)

## What to change

### Step 1: Fix the tool schema in `tool-schemas.ts`

Replace the single `manage_dns_records` tool with a schema that matches the four actual actions. Two options:

**Option A: Split into separate tools (recommended)** — Cleaner, each tool is either read-only or mutating:

```typescript
// Read-only DNS tools
{
  name: 'list_dns_zones',
  description: 'List Route 53 hosted zones.',
  properties: {},
},
{
  name: 'list_dns_records',
  description: 'List DNS records in a Route 53 hosted zone.',
  properties: {
    zoneId: { type: 'string', description: 'Route 53 hosted zone ID' },
    name: { type: 'string', description: 'Optional record name filter' },
  },
  required: ['zoneId'],
},
// Mutating DNS tools
{
  name: 'create_dns_record',
  description: 'Create a DNS CNAME record in a Route 53 hosted zone.',
  properties: {
    zoneId: { type: 'string', description: 'Route 53 hosted zone ID' },
    name: { type: 'string', description: 'Record name (e.g. "www.example.com")' },
  },
  required: ['zoneId', 'name'],
},
{
  name: 'delete_dns_record',
  description: 'Delete a DNS record from a Route 53 hosted zone.',
  properties: {
    zoneId: { type: 'string', description: 'Route 53 hosted zone ID' },
    name: { type: 'string', description: 'Record name to delete' },
  },
  required: ['zoneId', 'name'],
},
```

**Option B: Fix the enum values** — Keep one tool but fix the action enum:

```typescript
{
  name: 'manage_dns_records',
  description: 'List, create, or delete DNS records in Route 53.',
  properties: {
    action: { type: 'string', enum: ['list_zones', 'list_records', 'create_cname', 'delete_record'] },
    zoneId: { type: 'string', description: 'Route 53 hosted zone ID (required for all actions except list_zones)' },
    name: { type: 'string', description: 'Record name (required for list_records, create_cname, delete_record)' },
  },
  required: ['action'],
},
```

Option A is recommended because it cleanly separates read-only from mutating tools, which the assistant's confirmation flow relies on.

### Step 2: Update `assistant-tools.ts`

If using Option A, add description overlays for each new tool:

```typescript
list_dns_zones: 'List Route 53 hosted zones (read-only, runs automatically).',
list_dns_records: 'List DNS records in a Route 53 hosted zone (read-only, runs automatically).',
create_dns_record: 'Create a DNS CNAME record. The user confirms before creation.',
delete_dns_record: 'Delete a DNS record. The user confirms before deletion.',
```

Remove the `manage_dns_records` entry.

### Step 3: Update `assistant.ts` READ_ONLY_TOOLS and executeReadOnlyTool

Add read-only DNS tools:

```typescript
const READ_ONLY_TOOLS = new Set([
  // ... existing entries ...
  "list_dns_zones",
  "list_dns_records",
]);
```

Add cases in `executeReadOnlyTool`:

```typescript
case "list_dns_zones": {
  return gatewayService.listDnsZones();
}
case "list_dns_records": {
  return gatewayService.listDnsRecords(String(input.zoneId ?? ""), str(input.name));
}
```

### Step 4: Update `AssistantBar.tsx` dispatch

If using Option A, replace the `manage_dns_records` case with individual cases:

```typescript
case 'list_dns_zones':
  return api.dnsListZones();
case 'list_dns_records':
  return api.dnsListRecords(String(input.zoneId ?? ''), str(input.name));
case 'create_dns_record':
  return api.dnsCreateRecord(String(input.zoneId ?? ''), 'create_cname', String(input.name ?? ''));
case 'delete_dns_record':
  return api.dnsDeleteRecord(String(input.zoneId ?? ''), String(input.name ?? ''));
```

Note: `api.dnsCreateRecord` takes an `action` string as its second parameter. The current client passes the literal string `'create_cname'`. Check `api.ts` to see what the server expects.

### Step 5: Update MCP tools

In `mcp/src/tools.ts` (or wherever MCP tools are defined from `COMMON_TOOL_SCHEMAS`), the tool definitions will be automatically included if using `COMMON_TOOL_SCHEMAS`. Verify the new tool names appear in the MCP tool list.

## Verification

1. Start the dev server
2. Ask the assistant "List my DNS zones" — should call `list_dns_zones` automatically (no confirmation)
3. Ask "Show DNS records for zone Z123" — should call `list_dns_records` automatically
4. Ask "Create a CNAME record www.example.com in zone Z123" — should require confirmation, then call `create_dns_record`
5. Ask "Delete the www.example.com DNS record" — should require confirmation, then call `delete_dns_record`
6. Verify none of these throw "Unknown DNS action" errors