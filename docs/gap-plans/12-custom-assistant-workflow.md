# Prompt 12 — Custom-assistant workflow: prompt composition, tool-picker integrity, routing, dead features

You are an LLM coding agent working in `miltonejones/docker-iaas` (project
**Dockyard**). Dockyard lets users create **custom assistants** (Settings →
Assistants): a name, description, system prompt, a subset of tools, a voice,
an icon, and a default flag. A 2026-08-01 review found that most of this
surface is broken, misleading, or silently degrades the assistant. This
prompt fixes the *workflow* defects. (The related *security* defects are
prompt 11 — run that one first; this prompt assumes its changes are merged.)

## Global rules you must obey

- Branch: `gap/12-custom-assistant-workflow`, from latest `origin/main`.
  Never push to `main`. Never force-push.
- Depends on: prompt 11 merged (fail-closed `resolveAssistantOpts`, session
  ownership). If `resolveAssistantOpts` still silently returns `undefined`
  on a missing assistant, STOP and do prompt 11 first.
- Protected files — do NOT touch: `Dockerfile.consumer`, `docker-compose.yml`,
  `docker-compose.ci.yml`, `Caddyfile`, `.gitignore`,
  `.github/workflows/deploy.yml`, `scripts/issue-consumer.mjs`,
  `scripts/protected-files.json`, `scripts/smoke-test-hardening.sh`.
- Do not remove the `playwright` dependency. Zero new npm dependencies.
- Copy existing UI patterns (`web/src/styles.css` conventions, `api.ts`
  helper style, toast/confirm contexts). No new libraries, no redesigns.

## Read these files fully before writing any code

1. `server/src/routes/assistant.ts` — the built-in `SYSTEM` prompt (a long
   template literal near the top) and `resolveAssistantOpts`.
2. `server/src/assistant-tools.ts`, `server/src/tool-schemas.ts`,
   `server/src/databaseAssistantTools.ts`,
   `server/src/githubAssistantTools.ts` — the REAL tool registry (the
   `tools` array ultimately sent to the model).
3. `server/src/services/assistants.ts` + the `user_assistants` helpers in
   `server/src/db.ts` — create/update/validation (currently: none).
4. `web/src/components/AssistantsSettings.tsx` — the creation UI, including
   the hardcoded `TOOL_CATEGORIES` list and the `VOICES` list.
5. `web/src/components/AssistantBar.tsx` — `resolveAssistant` (@name
   routing), `activeAssistantId` state, the TTS voice-matching effect, and
   `consumeTurnStream`.

## Background: the defects this prompt fixes

- **D1 — Custom prompts erase the operating manual.** `resolveAssistantOpts`
  uses `assistant.systemPrompt || SYSTEM`: a custom prompt REPLACES the
  built-in SYSTEM prompt entirely. That built-in prompt carries the
  operational contracts (lambda `DOCKYARD_REQUEST`/response shape, gateway
  pathPattern exact-match semantics, "send complete file contents" rules,
  the mandatory `wait` between polls, confirmation etiquette,
  knowledge-bucket conventions). A persona like "You are a DevOps helper"
  therefore produces an assistant that writes broken gateway lambdas and
  rapid-fire polls.
- **D2 — Tool picker drift.** The UI's `TOOL_CATEGORIES` is a hardcoded
  copy of the tool registry, and it has already drifted: six real tools are
  unpickable (`wait`, `copy_to_container`, `get_consumer_status`,
  `get_consumer_activity`, `check_consumer_health`, `retry_issue`). Any
  assistant with a non-empty tool list silently loses `wait` (which the
  SYSTEM prompt mandates) and the consumer-status loop. The server also
  never validates `toolList` contents — typos are stored silently and
  filter to nothing.
- **D3 — Routing is misleading and broken for real names.** The settings UI
  says the description is "used for auto-routing" — no auto-routing exists
  anywhere. The only routing is an exact `@name` prefix match via
  `/^@(\S+)/`, which can never match names containing spaces — including
  "UI Designer", the form's own placeholder suggestion.
- **D4 — `isDefault` is dead.** Stored, badged, settable on several
  assistants at once (no single-default enforcement), and read by nothing:
  new chats always start on the built-in assistant.
- **D5 — Voice cannot work.** The picker offers OpenAI TTS voice names
  (`alloy`, `ash`, …) but playback uses browser `speechSynthesis` voices,
  matched by substring against names like "Google US English". The match
  essentially never succeeds.
- **D6 — No validation.** No name length/uniqueness rules (duplicate names
  make `@name` ambiguous — `find()` picks whichever is first), no
  systemPrompt size cap (assistant routes accept 10 MB bodies; the prompt
  is re-sent to the model every turn), voice unvalidated, toolList not
  checked to be `string[]` (a bad value later throws inside `JSON.parse`
  → the whole assistant list 500s).
- **D7 — Silent stall at the auto-round cap.** `streamTurn` allows
  `MAX_AUTO_ROUNDS = 8` consecutive read-only rounds; hitting the cap exits
  the loop without emitting ANY terminal event — the SSE stream just ends
  and the user sees a spinner resolve into nothing.

## Step-by-step instructions

### Step 1 — Prompt composition (fixes D1)

1. Add a column to `user_assistants` via the established migration idiom in
   `db.ts` (guarded `ALTER TABLE`): `prompt_mode TEXT NOT NULL DEFAULT 'append'`.
   Allowed values: `'append'` | `'replace'`.
2. In `server/src/routes/assistant.ts`, split the current `SYSTEM` template
   literal into two exported constants in place (do not move them to a new
   file; keep the diff reviewable):
   - `SYSTEM_CORE` — everything that is an operational contract: the tool
     usage rules, lambda/gateway contracts, wait-tool mandate, confirmation
     etiquette, knowledge-base conventions. In practice: the entire
     `Rules:` block and the knowledge-base paragraph.
   - `SYSTEM_PERSONA` — the identity/behavior lines (the opening "You are
     the Dockyard.ai assistant…" paragraph and the projects paragraph).
   - `SYSTEM` remains `SYSTEM_PERSONA + SYSTEM_CORE` so the default
     assistant's prompt is byte-identical to today. Add a test asserting
     that (snapshot the concatenation against the previous literal —
     copy the old full text into the test as the expected value).
3. Change `resolveAssistantOpts`:
   - `prompt_mode === 'append'` (the default): system =
     `SYSTEM_PERSONA + SYSTEM_CORE + '\n\n## Custom instructions for this assistant\n' + assistant.systemPrompt`
     (omit the suffix entirely when systemPrompt is empty).
   - `prompt_mode === 'replace'`: system = `assistant.systemPrompt || SYSTEM`
     (today's behavior, now opt-in).
4. Surface it in `AssistantsSettings.tsx`: a radio group under the system
   prompt textarea — "Add to the built-in prompt (recommended)" /
   "Replace the built-in prompt (advanced — the assistant loses Dockyard's
   built-in tool instructions)". Default `append`. Wire through
   `services/assistants.ts`, the router, `web/src/api.ts`, and
   `web/src/types.ts` following the exact shape of the existing fields.
5. Existing assistants: the column default is `'append'`, which CHANGES
   behavior for anyone who previously wrote a full replacement prompt.
   Handle it in the migration: when adding the column, backfill
   `prompt_mode = 'replace'` for rows where `system_prompt != ''` (they
   were authored under replace semantics), and leave `'append'` for rows
   with an empty prompt. State this in a comment and in the PR description.

### Step 2 — Tool picker from the real registry + server-side validation (fixes D2, part of D6)

1. Server: add `GET /api/assistants/meta/tools` to
   `server/src/routes/assistants.ts` (mount it BEFORE the `/:id` route so
   `meta` is not swallowed as an id — this router matches `/:id` broadly;
   verify the order). Response:
   `{ tools: [{ name, description, category, readOnly }] }` where the list
   is derived from the ACTUAL `tools` array the chat uses (import it from
   `../assistant-tools.js`), `readOnly` comes from membership in the
   `READ_ONLY_TOOLS` set (export that set from `routes/assistant.ts` — it
   is currently module-local), and `category` from a small server-side
   name→category map. Build the category map by porting the UI's existing
   `TOOL_CATEGORIES` grouping to the server, then ADD the six missing
   tools: `wait` and the consumer tools under a new "Automation" category,
   `copy_to_container` under "Containers". Every tool in the registry MUST
   have a category — add a unit test that walks the registry and fails on
   an uncategorized tool name, so future drift breaks CI instead of the UI.
2. UI: `AssistantsSettings.tsx` deletes its hardcoded `TOOL_CATEGORIES` and
   fetches the meta endpoint on mount (existing `api.ts` helper style;
   loading state like the assistant list's). Group by `category`, badge
   read-only tools with a subtle "read" chip so users understand which
   choices grant mutations.
3. Server-side validation of `toolList` on create AND update, in
   `services/assistants.ts`:
   - must be an array of strings (400 otherwise:
     `'toolList must be an array of tool names.'`);
   - every entry must exist in the real registry (400 listing the unknown
     names verbatim);
   - **auto-include rule**: if the list is non-empty and omits `wait`, add
     `wait` server-side — the SYSTEM prompt mandates wait-between-polls and
     an assistant without it violates its own instructions. Mention the
     auto-inclusion in the meta endpoint response
     (`alwaysIncluded: ["wait"]`) and gray `wait` out as always-on in the
     picker rather than hiding it.
4. Sweep for existing bad rows: on `list()`/`get()` in
   `services/assistants.ts`, `JSON.parse(r.tool_list || '[]')` can throw on
   corrupt data and 500 the whole list. Wrap it: on parse failure, treat as
   `[]`, and log a warning with the assistant id. One bad row must never
   take down the assistants page.

### Step 3 — Routing: fix @name, make the description label honest (fixes D3)

1. Fix `resolveAssistant` in `AssistantBar.tsx` to support multi-word
   names, longest-match-first, case-insensitive:
   - Build candidates sorted by name length descending; for each, test
     whether the input starts with `@` + name (case-insensitive) followed
     by end-of-string or whitespace. First match wins. This makes
     `@ui designer deploy the site` resolve the "UI Designer" assistant and
     strip exactly `@ui designer`.
   - Duplicate names: the server should prevent them going forward (Step
     5), but the resolver must still behave deterministically — if two
     candidates tie, pick the most recently updated and show a toast
     warning that the name is ambiguous.
2. Auto-routing: do NOT implement description-based auto-routing in this
   prompt (routing user text through a classifier is a feature decision
   with cost implications). Instead make the UI honest:
   - Change the settings label from "Description (used for auto-routing)"
     to "Description".
   - Show the description as secondary text in the assistant picker
     dropdown in `AssistantBar.tsx` (it is currently unused there), so the
     field has a real purpose.
   - Note in the PR description: "Description-based auto-routing was
     advertised but never implemented; label corrected. If auto-routing is
     wanted, it needs its own design (likely the title-model classifying
     against assistant descriptions)."

### Step 4 — Make `isDefault` real (fixes D4)

1. Single-default enforcement, server-side, in `db.ts`: when creating or
   updating an assistant with `is_default = 1`, clear the flag on every
   other assistant of the same user, inside one transaction
   (better-sqlite3 `db.transaction`). Add a test: set default on B when A
   was default → A loses it, exactly one default remains.
2. Honor it: in `AssistantBar.tsx`, when a NEW conversation starts (no
   session loaded, `activeAssistantId` is null), initialize
   `activeAssistantId` to the user's default assistant if one exists (the
   assistants list is already fetched on mount — derive from it; no new
   API call). Loading an existing session must still use the session's own
   assistant binding — verify the load path takes precedence by reading
   the session-load effect before wiring this.
3. The picker's built-in "Ask Dockyard.ai" entry must remain selectable so
   the user can always get back to the stock assistant even with a default
   set.

### Step 5 — Validation and limits (fixes D6, rest)

In `services/assistants.ts` (create and update, one shared validator):

1. `name`: trimmed, 1–40 characters, must not start with `@`, and must be
   unique among the user's assistants case-insensitively (409,
   `'You already have an assistant named "<name>".'`). Uniqueness check in
   the service via a small db helper, not in the route.
2. `description`: max 200 chars (400 above).
3. `systemPrompt`: max 20,000 characters (400 above, message stating the
   limit and why: "the system prompt is resent on every model call").
4. `voice`: must be one of the allowed voice ids (single source: export the
   list from the server — see Step 6 — and validate against it; 400
   otherwise).
5. `icon`: when present, max 16 UTF-16 code units after trim (enough for
   any emoji grapheme; the client already clamps to one grapheme — this is
   the server-side backstop).
6. Cap assistants per user at 50 (400: `'Assistant limit reached (50).'`).
7. Tests for every rule, both create and update paths, plus: update must
   not be able to bypass a rule create enforces (write the update tests by
   copying each create test and switching the verb).

### Step 6 — Voice: make it honest (fixes D5)

The `VOICES` list (`alloy`…`verse`) is OpenAI TTS nomenclature; playback
uses browser `speechSynthesis` and substring-matches these names against
browser voice names, which essentially never match. Do the smallest honest
fix — **do not integrate a TTS API**:

1. Server: store whatever voice id is chosen (validation list from Step 5);
   move the canonical voice list to the server (a constant exported from
   `services/assistants.ts`, surfaced in the `meta/tools` response as
   `voices: string[]` — rename the endpoint to `/api/assistants/meta` while
   you are in Step 2 if that reads better, but keep it ONE endpoint).
2. Client: replace the hardcoded OpenAI-name dropdown with the voices the
   browser ACTUALLY has: populate the select from
   `speechSynthesis.getVoices()` (label: voice name + language), store the
   selected `voiceURI` string as the assistant's `voice`. The TTS effect in
   `AssistantBar.tsx` then matches by exact `voiceURI` instead of fuzzy
   substring. Keep backward compatibility: if a stored voice value matches
   no current voiceURI (old rows with "alloy", or a different machine),
   fall back to the browser default voice silently — never break speech
   because of a stale preference.
3. `getVoices()` is asynchronously populated in some browsers — handle the
   `voiceschanged` event exactly the way the existing TTS code in
   `AssistantBar.tsx` does (read it first; if it doesn't handle the event,
   add the listener in both places).
4. Since the voice list is now browser-derived, drop the Step 5 server-side
   allowlist for `voice` and validate only shape (string, ≤ 200 chars).
   Reconcile the two steps in your implementation — the final state is:
   server stores an opaque bounded string, client owns the vocabulary.

### Step 7 — Terminal event at the auto-round cap (fixes D7)

1. In `streamTurn`, after the `for` loop ends by exhausting
   `MAX_AUTO_ROUNDS` (i.e. the loop completes without an early `return`),
   emit a final event before returning:
   `onEvent({ type: 'turn', messages, pending: [], autoResolved: [], done: true, text: '⚠️ Stopped after 8 consecutive automatic tool rounds without a final answer. Ask me to continue if you want me to keep going.' })`.
   Keep the wording; the client renders `text` as the assistant message and
   the conversation stays continuable (`messages` still carries the full
   history).
2. Client: no change needed — verify by reading `consumeTurnStream` that a
   `turn` with `done: true` ends the busy state and renders the text.
3. Test: unit-level is enough — extract nothing; instead drive `streamTurn`
   with a fake Anthropic client whose stream always returns one read-only
   `tool_use` block (the existing test files show how the app is built for
   injection via `createApp`; if constructing a fake client is genuinely
   impractical with the current seams, add the smallest possible seam: an
   optional client parameter already flows in — read `sessionRunner.ts`
   and `getAssistantClient` and choose the least invasive injection point,
   documenting the choice in the PR).

## Things you must NOT do

- Do not implement description-based auto-routing (Step 3 makes the UI
  honest instead).
- Do not integrate a cloud TTS provider.
- Do not consolidate the `/plan`+`/confirm` and `/send`+`/stream` pipelines
  — out of scope; mention the duplication as future work in the PR.
- Do not change the built-in default assistant's effective prompt: the
  Step 1 test proves `SYSTEM` is byte-identical after the split.
- Do not add npm dependencies.
- Do not weaken any prompt-11 security behavior.

## Acceptance criteria

1. Custom assistants default to append-mode prompts; replace-mode is
   opt-in; pre-existing prompt-authoring assistants are backfilled to
   replace; the stock SYSTEM prompt is byte-identical (test-proven).
2. The tool picker is generated from the server registry; the six missing
   tools are pickable (with `wait` always included in non-empty lists);
   unknown/malformed toolLists are rejected with 400; corrupt stored rows
   degrade to `[]` instead of 500ing the list.
3. `@ui designer …` resolves a multi-word assistant name; the label no
   longer claims auto-routing; descriptions show in the picker.
4. Exactly one default assistant per user is possible, and new
   conversations start on it.
5. All Step 5 validation rules enforced on create AND update, with tests.
6. Voice selection lists real browser voices and round-trips by voiceURI;
   stale values fall back silently.
7. Hitting the 8-round cap yields a visible assistant message, never a
   silent stall.
8. `npm run typecheck`, `npm test`, `npm run lint` pass.

## Verification

```bash
npm run typecheck && npm test && npm run lint
# Manual, with dev server: create "UI Designer" with 3 tools + a persona
# prompt in append mode; ask it "@ui designer what tools do you have?";
# confirm it self-describes with the built-in rules intact and only the
# chosen tools; delete it; confirm the bound session reports 410 (prompt 11
# behavior still intact).
```

Describe the manual run in the PR description.

## Commit and push

One commit per step (`feat(gap-12): ...` / `fix(gap-12): ...`), then
`git push -u origin gap/12-custom-assistant-workflow`; PR title
`feat: custom-assistant workflow — prompt composition, live tool registry, routing and validation fixes`.
