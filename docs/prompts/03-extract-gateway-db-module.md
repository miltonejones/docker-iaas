# Prompt: Extract gateway persistence from `server/src/db.ts`

Refactor `server/src/db.ts` by extracting gateway-related persistence into a dedicated module.

## Goal

Create a new file `server/src/db/gateway.ts` and move gateway persistence responsibilities into it.

Move these categories of logic:
- route CRUD
- custom-domain helpers
- gateway traffic telemetry helpers
- related row/filter/summary types

## Why this matters in Dockyard

Gateway routing is one of Dockyard's most important subsystems. It spans:
- route CRUD
- custom domain state
- telemetry collection
- route lookup at runtime

Right now, all of that persistence logic is mixed into a giant shared DB file. Extracting gateway persistence into its own module reduces cognitive load and makes future hardening safer, especially as public edge behavior grows more complex.

## Functions to move

Move functions in these categories:
- `listRoutes`
- `getRoute`
- `getRouteByName`
- `getRoutesByName`
- `createRoute`
- `updateRoute`
- `deleteRoute`
- `getRouteByDomain`
- `getRouteByDomainAnyStatus`
- `setRouteDomain`
- `verifyRouteDomain`
- `setRouteDomainDnsManaged`
- `recordGatewayTrafficEvent`
- `summarizeGatewayTraffic`
- `summarizeGatewayTrafficByHour`
- `listGatewayTrafficEvents`

Also move related types such as:
- `RouteRow`
- telemetry row/filter/summary interfaces

## Instructions

1. Create `server/src/db/gateway.ts`.
2. Move gateway-related SQL helpers and types into it.
3. Keep startup table creation/migration working.
4. Preserve SQL and behavior unless a tiny compatibility fix is needed.
5. Update route handlers and runtime callers to import from the new module.
6. Keep unrelated domains in place for now.

## Constraints

- Do **not** redesign the gateway API.
- Do **not** change route semantics.
- Do **not** combine this with assistant or database-ops extraction.
- Keep the PR focused on extraction, not cleanup churn.

## Acceptance criteria

- `server/src/db/gateway.ts` exists and owns gateway persistence.
- `server/src/routes/gateway.ts` and any runtime users compile against the new module.
- Runtime behavior is unchanged.
- `npm run typecheck` passes.
- `npm test` passes.
