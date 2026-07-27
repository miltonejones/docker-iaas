# Fix: add project context to the assistant system prompt

## Problem

The `SYSTEM` prompt in `server/src/routes/assistant.ts` (around lines 118-148) lists resource types the assistant can manage — "Lambda functions, Gateway routes, containers, Docker images, storage buckets, and saved MySQL/MongoDB connections" — but never mentions projects. The individual tool descriptions say `projectId` is an optional filter, but without system-level guidance, the model doesn't proactively suggest project-based organization or know when to apply projectId filters.

## Location

`server/src/routes/assistant.ts` — the `SYSTEM` constant (around line 118).

## What to change

Add a paragraph about projects to the system prompt. Find the existing resource list and extend it. Here's a suggested addition — place it after the paragraph that lists resource types:

```
Projects organize resources — containers, functions, gateway routes, and buckets can all be assigned to a project. Use list_projects to see existing projects and their resource counts. When creating a resource, pass projectId to assign it. When listing resources, pass projectId to filter by project. If the user mentions a project by name, call list_projects first to resolve the name to an ID.
```

Also add "projects" to the list of resource types in the existing paragraph so the model knows they exist.

## Verification

1. Start the dev server
2. Open the assistant and ask "What projects do I have?"
3. Verify it calls `list_projects` without requiring confirmation
4. Ask "Create a container in my X project" — verify it calls `list_projects` first to resolve the name, then `launch_container` with the resolved `projectId`