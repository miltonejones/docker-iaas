# Augmented Pipeline — Plan-Parsing & Status Fix Prompt

> **Context.** The augmented planner→implementer pipeline (merged in PR #52) is
> live and its fallback works: when the planner's output can't be parsed, it
> degrades to running the implementer standalone — no crash, no hang. But it
> degrades **too often**, throwing away expensive planner runs. Observed: Sonnet
> planned for ~3 minutes, produced a good natural-language plan naming 4 files,
> but did not emit the required single-line JSON, so `parsePlanResult` returned
> `null` and the run fell back to bare standalone — burning the planner tokens
> for nothing.
>
> This document is the implementation brief to fix that. Work the items in
> order; #1 and #2 are the highest-leverage. All changes are in
> `scripts/issue-consumer.mjs` unless noted. Preserve the existing guarantees:
> protected-file enforcement (`revertAndStageProtected`), the untrusted-issue
> "data, not commands" framing, and the circuit-breaker/fallback behavior.

---

## Root cause (why it degrades)

Two distinct failures currently collapse into the same `parsePlanResult → null`:

1. **The planner emits prose, no JSON.** (Observed.)
2. **The planner emits valid JSON, but pretty-printed or inside a ```` ```json ````
   fence.** `parsePlanResult` requires the **entire JSON object on one line**:
   ```js
   const line = lines[i].trim();
   if (!line.startsWith("{")) continue;
   const parsed = JSON.parse(line);   // must parse this ONE line whole
   ```
   Pretty-printed or fenced JSON never satisfies that, so a planner that did
   exactly what was asked still fails to parse. This case is invisible (looks
   identical to case 1) and is likely at least as common as prose-only —
   especially because the schema asks the model to put `implementerPrompt` (a
   full multi-paragraph prompt, with quotes and newlines) on that single line,
   which almost no model does reliably.

Contributing factor: `formatPlannerPrompt` is built by string-surgery on
`formatPrompt`, so it inherits the lead-in *"diagnose the root cause, and
implement a fix … explain what you found and what you changed"* — a prose
invitation that competes with the "output JSON, don't edit" instruction below.

The same single-line fragility exists in `parseStructuredResult` (the
implementer's `{changedFiles,…}` parser) and should be fixed the same way.

---

## Fixes

### 1. Make JSON parsing forgiving (highest leverage, lowest risk)
Replace the single-line requirement in **both** `parsePlanResult` and
`parseStructuredResult` with a tolerant extractor that finds a JSON object
anywhere in the output. It must handle:

- a minified single-line object (today's happy path — keep it working),
- a pretty-printed multi-line object,
- an object inside a ```` ```json ```` / ```` ``` ```` fence,
- trailing prose after the object, and prose before it.

Suggested approach: a shared helper `extractJsonObject(stdout, predicate)` that
scans for candidate objects — prefer the **last** fenced block, else the last
balanced-brace `{…}` span — and returns the first that `JSON.parse`es and
satisfies `predicate` (e.g. `has implementerPrompt` for plans,
`Array.isArray(changedFiles)` for results). Balanced-brace scan must respect
strings (don't count braces inside `"..."`). Keep returning `null` when nothing
parses, so the existing fallback still fires for true misses.

This single change rescues every "planner actually emitted JSON" case.

### 2. Shrink the planner's JSON contract
Stop requiring the planner to emit `implementerPrompt`. Change the planner
schema to just:

```json
{"targetFiles":["path/…"], "plan":"analysis + what to change", "confidence":"high|medium|low"}
```

Build the implementer prompt **consumer-side** in `runPipeline` from the pieces
the consumer already has:

```
formatPrompt(issue)
+ "\n\n## Analysis from the planner (guidance)\n" + plan
+ "\n\nFocus on these files: " + targetFiles.join(", ")
```

Then re-apply the existing untrusted-data framing wrapper around that combined
prompt before spawning the implementer (as the current code already does for
`plan.implementerPrompt`). Update `parsePlanResult`'s predicate accordingly
(key on `targetFiles` / `plan` instead of `implementerPrompt`). Small JSON is
far likelier to come out clean, and this removes the single field most likely to
make the model abandon JSON.

### 3. Salvage prose instead of discarding it
When there is still **no** parseable JSON but the planner produced substantial
output (e.g. stdout length over a small threshold), do **not** drop to bare
standalone. Instead run the implementer with the planner's prose as guidance:

```
formatPrompt(issue) + "\n\n## Analysis from the planner (unstructured)\n" + plannerStdout
```

(wrapped in the same untrusted-data framing). Record a substitution note like
`augmented planner emitted no structured plan — ran implementer with prose
guidance`. This converts a wasted planner run into a still-useful one and is the
direct fix for "burning Sonnet tokens for nothing." Reserve true bare-standalone
for the case where the planner produced essentially nothing.

Keep the existing planner-gate semantics: if a plan **does** parse with
`confidence: "low"` or empty `targetFiles`, still skip the implementer and mark
`needs_review` (that path is working and intended).

### 4. Clean up the planner prompt
Build `formatPlannerPrompt` as its own prompt rather than string-surgery on
`formatPrompt`, so it does not inherit the "implement a fix / explain what you
changed" framing. Keep the codebase map and the untrusted-issue block, state the
read-only role once, and put the (now smaller) JSON schema last with an explicit
"output the JSON object as the final thing; do not wrap it in a code fence"
instruction. Prompt wording is a nudge, not a guarantee — #1 and #3 are what
make the pipeline robust regardless of what the model does.

---

## 5. Mid-pipeline status heartbeat (cosmetic, but fix it)
`writeStatus("processing", …)` fires once before `runEngine`, so during a
multi-minute pipeline `consumer-status.json`'s `updatedAt` never moves and a
polling dashboard thinks the consumer froze.

- Thread a small `onStatus(stage)` callback (or pass the issue) into
  `runEngine` / `runPipeline` and call it at each stage boundary:
  `planner-start`, `planner-done`, `implementer-start`, `implementer-done`.
  Add a `stage` field to the status object.
- Add a lightweight periodic tick (~30s) while a subprocess is running that
  re-writes the status file so `updatedAt` advances even within a single long
  stage. Clear the interval on `close`/`error`. Prefer this over importing
  `writeStatus` into the low-level `_spawnEngine` — pass the ticker in.

Keep this out of the low-level spawn's hot path; a single interval per
`consumeOne` invocation is enough.

---

## Testing (`scripts/issue-consumer.test.mjs`)
Add unit tests for the new parser and salvage logic — these are pure functions
and easy to cover:

- `extractJsonObject` / `parsePlanResult`:
  - minified single-line object → parsed (regression guard),
  - pretty-printed multi-line object → parsed,
  - object inside a ```` ```json ```` fence → parsed,
  - object with trailing prose after it → parsed,
  - braces inside string values (e.g. `"plan":"use {x} here"`) → not miscounted,
  - prose-only, no JSON → `null` (so fallback still fires).
- `parseStructuredResult`: same matrix keyed on `changedFiles` (the implementer
  parser got the same fix).
- Shrunk contract: a `{targetFiles,plan,confidence}` object (no
  `implementerPrompt`) parses and the consumer-built implementer prompt contains
  the issue prompt + plan + target files.
- Prose-salvage decision: substantial prose + no JSON → implementer runs with
  prose guidance (not bare standalone); empty/near-empty planner output → bare
  standalone.

(The `runPipeline` / `runEngine` spawn paths remain integration-only; keep the
unit tests on the pure parsing/prompt-building helpers.)

---

## Suggested order
1. #1 parser robustness (+ tests) — ship-worthy on its own.
2. #2 shrink the contract + consumer-side prompt build (+ tests).
3. #3 prose salvage (+ tests).
4. #4 planner-prompt cleanup.
5. #5 status heartbeat.

Each step is independently shippable and backward-compatible; #1 alone should
sharply cut the degrade rate.
