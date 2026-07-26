# Prompt: Standardize JWT secret handling between console and consumer

Standardize JWT secret handling between the `console` and `consumer` services.

## Goal

Remove insecure or inconsistent JWT secret configuration paths and make both services follow the same secret-loading model.

## Why this matters in Dockyard

Dockyard now has stronger JWT handling in the main server, including fail-fast behavior if no secret is present. But secret handling is still not fully consistent across services.

Because Dockyard includes:
- authenticated UI/API access
- assistant-triggered automation
- a consumer process that can interact with privileged backend flows

JWT secret handling must be predictable and consistent everywhere.

## Instructions

1. Remove the hardcoded consumer fallback value `dockyard-dev-secret-change-in-production` from `docker-compose.yml`.
2. Make the consumer use the same secret source strategy as the console where practical.
3. Prefer Docker secrets via `/run/secrets/jwt_secret`.
4. If an environment fallback is necessary for local development, make it explicit and safe.
5. Update startup/config loading in the consumer if needed.
6. Update README or config docs to reflect the new behavior.
7. Preserve local development ergonomics as much as possible.

## Constraints

- Do **not** weaken the console's current fail-fast behavior.
- Do **not** introduce a silent insecure production default.
- Do **not** mix this task with unrelated auth redesign.

## Acceptance criteria

- Console and consumer use a consistent JWT secret source strategy.
- No hardcoded insecure-looking production fallback remains.
- Local dev still has a documented path.
- `npm run typecheck` passes.
- `npm test` passes.
