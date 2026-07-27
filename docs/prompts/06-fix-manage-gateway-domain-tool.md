# Fix: manage_gateway_domain action enum mismatch

## Problem

The `manage_gateway_domain` tool has the same pattern as `manage_dns_records` — the schema enum doesn't match what the client dispatch handles.

**Schema** defines `action` with two values: `['set', 'clear']`

**Client dispatch** (`AssistantBar.tsx` lines 940-951) handles four: `set`, `enable`, `status`, `remove`

| Action | In schema? | Client handles? | Result |
|--------|-----------|-----------------|--------|
| `set` | ✅ | ✅ | Works |
| `clear` | ✅ | ❌ | **Runtime error**: "Unknown domain action: clear" |
| `enable` | ❌ | ✅ | **Unreachable**: LLM can't produce this action |
| `status` | ❌ | ✅ | **Unreachable**: LLM can't produce this action |
| `remove` | ❌ | ✅ | **Unreachable**: LLM can't produce this action |

Additionally, `status` is read-only (it just checks domain verification status) but is lumped in with mutating actions requiring confirmation.

## Location

- `server/src/tool-schemas.ts` line 347 — schema enum `['set', 'clear']`
- `server/src/assistant-tools.ts` line 23 — description mentions only "set" and "clear"
- `web/src/components/AssistantBar.tsx` lines 940-951 — dispatch handles `set`, `enable`, `status`, `remove`

## What to change

### Option A: Split into separate tools (recommended)

Split into 4 tools — 1 read-only, 3 mutating — matching the actual API endpoints:

```typescript
// Read-only (auto-resolved, no confirmation)
{
  name: 'check_gateway_domain_status',
  description: 'Check the verification status of a custom domain on a gateway route. Read-only, runs automatically.',
  properties: { id: { type: 'string', description: 'Gateway route ID' } },
  required: ['id'],
},

// Mutating (require confirmation)
{
  name: 'set_gateway_domain',
  description: 'Set a custom domain on a gateway route. The user confirms before the domain is assigned.',
  properties: {
    id: { type: 'string', description: 'Gateway route ID' },
    domain: { type: 'string', description: 'Domain name to assign' },
  },
  required: ['id', 'domain'],
},
{
  name: 'enable_gateway_domain',
  description: 'Provision TLS certificate and configure DNS for a gateway route that has a domain assigned. The user confirms before enabling.',
  properties: { id: { type: 'string', description: 'Gateway route ID' } },
  required: ['id'],
},
{
  name: 'remove_gateway_domain',
  description: 'Remove a custom domain from a gateway route, tearing down TLS and DNS config. The user confirms before removal.',
  properties: { id: { type: 'string', description: 'Gateway route ID' } },
  required: ['id'],
},
```

### Option B: Fix the enum values

Keep one tool but expand the enum:

```typescript
action: { type: 'string', enum: ['set', 'enable', 'status', 'remove'], description: 'Action to perform' }
```

And add `domain` as an optional property (only needed for `set`).

### Step 2: Update `assistant-tools.ts` description

Replace the `manage_gateway_domain` description with descriptions for the new tools (if using Option A) or update the single description (if using Option B).

### Step 3: Update READ_ONLY_TOOLS

If using Option A, add `check_gateway_domain_status` to `READ_ONLY_TOOLS` and add a case in `executeReadOnlyTool`:

```typescript
case "check_gateway_domain_status":
  return gatewayService.checkDomainStatus(String(input.id ?? ""));
```

### Step 4: Update `AssistantBar.tsx` dispatch

If using Option A, replace the `manage_gateway_domain` case with individual cases:

```typescript
case 'check_gateway_domain_status':
  return api.gatewayDomainStatus(String(input.id ?? ''));
case 'set_gateway_domain':
  return api.gatewaySetDomain(String(input.id ?? ''), String(input.domain ?? ''));
case 'enable_gateway_domain':
  return api.gatewayEnableDomain(String(input.id ?? ''));
case 'remove_gateway_domain':
  return api.gatewayRemoveDomain(String(input.id ?? ''));
```

## Verification

1. Ask the assistant "Check the domain status for route X" — should auto-resolve (no confirmation)
2. Ask "Set domain example.com on route X" — should require confirmation, then call `set_gateway_domain`
3. Ask "Enable TLS for route X" — should require confirmation, then call `enable_gateway_domain`
4. Ask "Remove the domain from route X" — should require confirmation, then call `remove_gateway_domain`
5. Verify that `clear` and `manage_gateway_domain` are no longer referenced anywhere