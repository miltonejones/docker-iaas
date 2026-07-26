# Prompt: Add tests for JWT secret boot behavior

Add focused tests that verify Dockyard's auth boot behavior for JWT secret loading.

## Goal

Test the three key secret-loading cases:
1. secret file present
2. env fallback present
3. neither present, causing fail-fast behavior

## Why this matters in Dockyard

Dockyard's control plane is too privileged to tolerate ambiguous secret boot behavior. The auth layer should be explicit, testable, and hard to weaken accidentally.

These tests should guard the current hardening work and make future auth refactors safer.

## Instructions

1. Add tests covering:
   - reads secret from `/run/secrets/jwt_secret` when present
   - falls back to `JWT_SECRET` env when secret file is absent
   - fails fast when neither source exists
2. Refactor auth boot code only as much as necessary to make it testable.
3. Keep runtime behavior unchanged.
4. Prefer isolated tests over broad integration rewrites.

## Constraints

- Do **not** loosen the fail-fast requirement.
- Do **not** redesign auth middleware in this task.
- Keep the code changes narrowly focused on testability and coverage.

## Acceptance criteria

- Tests cover all three secret-loading paths.
- Runtime semantics remain unchanged.
- `npm test` passes.
- `npm run typecheck` passes.
