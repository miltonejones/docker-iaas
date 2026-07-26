# Prompt: Add focused tests for gateway audit logging

Add tests that verify gateway audit logging is actually triggered for the currently implemented gateway mutation paths.

## Goal

Cover these behaviors with targeted tests:
- route create emits an audit event
- route delete emits an audit event
- domain enable emits an audit event
- domain delete emits an audit event

## Why this matters in Dockyard

Dockyard now has initial audit hooks for gateway actions, but those hooks protect a high-value control surface: route creation, public exposure, and custom-domain activation. If those audit writes regress silently, operators may think critical actions are being tracked when they are not.

These tests should act as regression guards for the new safety boundary.

## Instructions

1. Add or update route-level tests for the gateway router.
2. Mock or spy on `recordAuditLog()`.
3. Verify the expected action names are emitted.
4. Verify authenticated user id propagation where applicable.
5. Keep the tests small and explicit.
6. Only test the audit contract here, not every unrelated route detail.

## Constraints

- Do **not** rewrite gateway behavior just to make tests easier.
- Do **not** over-test unrelated gateway telemetry or domain logic.
- Prefer clear route-level tests over heavy integration scaffolding.

## Expected action names

At minimum, verify these action names if they are the implemented ones:
- `gateway.route.create`
- `gateway.route.delete`
- `gateway.domain.enable`
- `gateway.domain.delete`

If implementation names differ, either align tests to the existing contract or make a small consistency fix.

## Acceptance criteria

- Gateway audit hooks are covered by tests.
- Tests fail if the audit hooks are removed.
- `npm test` passes.
- `npm run typecheck` passes.
