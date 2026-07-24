# Consumer Model Paradigms — Implementation Prompt

> **Purpose of this document.** This is a self-contained implementation brief for
> extending the Dockyard issue consumer to support per-issue model selection,
> a planner→implementer pipeline, and graceful degradation when a model is
> unavailable. Hand this to an implementing agent (or engineer) as the task
> spec. It describes the desired **end state** and the constraints — not a
> line-by-line patch. Read the referenced files before changing them.

---

## 1. Background — how the consumer works today

The consumer is a single Node daemon: `scripts/issue-consumer.mjs`.

1. Users create issues via `POST /api/assistant/issues`
   (`server/src/routes/assistant.ts` ~line 1780) with `{ summary, category,
   details }`. These are stored in the `assistant_issues` table
   (`server/src/db.ts` ~line 240): `id, summary, category, details_json,
   user_id, created_at, status, resolution, resolved_by`.
2. `issue-consumer.mjs` polls `GET /api/assistant/issues?status=open`, dedupes
   by summary (10-minute window, `isDuplicate`), and picks the first fresh
   issue.
3. It builds a prompt with `formatPrompt(issue)` and spawns **one** CLI
   subprocess (`consumeOne`, ~line 667):
   ```js
   spawn(DEEPSEEK_CMD, ["-p", prompt, "--model", DEEPSEEK_MODEL,
                        "--dangerously-skip-permissions"], …)
   ```
   `DEEPSEEK_CMD` defaults to `copilot` (dev) / `/usr/local/bin/claude` (prod,
   set in `docker-compose.yml`). `DEEPSEEK_MODEL` defaults to `deepseek-v4-pro`.
4. On success it parses a structured JSON result line
   (`parseStructuredResult`), and if files changed, commits, pushes
   `consumer/fix-<id>`, and opens an auto-merge PR (`pushToGitHub`).
5. It PATCHes the issue status back to the server (`updateIssueOnServer`):
   `deploying`, `needs_review`, or leaves it via error paths.

**The core limitation:** the model is a single global env var, identical for
every issue. There is no per-issue selection, no multi-stage pipeline, and no
fallback when the chosen model can't run.

**Current failure handling (the gap to close):**
- CLI fails to start (`child.once("error")`, ~line 814): logs, writes the
  prompt to the session log, resolves. The issue is **never updated** — it
  stays `open` and is retried against the *same* model after the dedupe window.
- CLI exits non-zero (~line 804): sets local status `errored`, notifies, but
  **does not update the issue on the server**. Same infinite-retry outcome.

So "no tokens / model unavailable" today becomes an infinite retry loop against
a model that cannot recover on its own.

---

## 2. Goal

Introduce **three selectable execution strategies** plus **graceful
degradation**, all built on one shared abstraction so there is no parallel code
path per strategy:

1. **User-selected** — the reporter picks the engine when creating the issue
   (e.g. Copilot, Claude+Sonnet, Claude+DeepSeek).
2. **Augmented** — a stronger model (Sonnet or Copilot) reads the issue,
   produces a plan and a crafted implementation prompt; a cheaper model
   (DeepSeek) does the actual file edits from that prompt.
3. **Auto (routing)** — optional, later: pick an engine based on `category`
   (e.g. trivial CSS/copy → cheap single-shot; logic/bug → augmented).

And crucially:

4. **Fallback / availability handling** — detect when an engine is unavailable
   (no tokens, rate limited, auth failure), route around it, and defer rather
   than fail when nothing is available.

---

## 3. Foundational abstraction — the engine registry

Everything below sits on one refactor. **Do this first; it is a no-behavior-change
step.**

Extract the single hardcoded `spawn(DEEPSEEK_CMD, …)` block in `consumeOne`
into a reusable function:

```js
async function runEngine(engineName, prompt) → {
  stdout, stderr, code,
  outcome: "ok" | "unavailable" | "transient" | "issue-failure",
  engineUsed,              // the engine that actually ran (may differ after fallback)
}
```

Back it with a registry that maps a **symbolic engine name** to a concrete
invocation. Single-model engines and pipeline engines both live here:

```js
const ENGINES = {
  "copilot":         { cmd: "copilot", model: "…",              fallback: ["claude-sonnet"] },
  "claude-sonnet":   { cmd: "claude",  model: "sonnet",         fallback: ["copilot"] },
  "claude-deepseek": { cmd: "claude",  model: "deepseek-v4-pro", fallback: ["claude-sonnet", "copilot"] },
  "augmented":       { pipeline: { planner: "claude-sonnet", implementer: "claude-deepseek" } },
  // "auto" resolves to one of the above at pick time (see §6).
};
```

Notes:
- "Claude + Sonnet" and "Claude + DeepSeek" are the **same `claude` binary**
  with a different `--model`. The registry makes that explicit.
- `DEEPSEEK_CMD` / `DEEPSEEK_MODEL` remain the **default engine** so existing
  deployments and issues with no engine keep working unchanged.
- The registry is the **allowlist**. No command string is ever built from raw
  user input (see security, §7).

Once `runEngine` exists, the downstream logic in `consumeOne` (parse result →
commit → push → update issue) is unchanged. Single-model engines call
`runEngine` once; augmented calls it twice.

---

## 4. Paradigm 1 — user-selected engine

### Data model
- Add an `engine TEXT` column to `assistant_issues` (`server/src/db.ts`), with
  the same defensive `ALTER TABLE … ADD COLUMN` migration pattern used for
  `status`/`resolution`/`resolved_by` (~line 257). Nullable / default `NULL`
  meaning "use the server/consumer default engine."
- **Store the engine in its own column, NOT inside `details_json`.** `details`
  is untrusted, user-submitted issue content (the prompt explicitly warns the
  model not to follow instructions embedded in it). The engine is a
  control-plane decision about *what binary runs*. These must not be mixed.

### Server
- In `POST /api/assistant/issues` (`assistant.ts` ~line 1780), accept an
  optional `engine` field. **Validate it against the registry allowlist**
  server-side; reject unknown values with `400`. Pass it through to
  `createAssistantIssue` (`db.ts` ~line 1254) and persist it.
- Include `engine` in `toIssueSummary` / the GET responses so the UI and
  consumer can read it.

### Consumer
- Read `issue.engine` and pass it to `runEngine`. If absent, use the default
  engine (current behavior).

### UI
- Add an engine selector to the issue-creation surface
  (`web/src/pages/IssueDetail.tsx` / `IssuesList.tsx`, `web/src/api.ts`).
- **Default to "Auto" / unset** — do not force reporters to choose. A dropdown
  that defaults to current behavior and lets power users override keeps it
  approachable and backward-compatible.

---

## 5. Paradigm 2 — augmented (planner → implementer)

A two-stage pipeline inside `runEngine` when the engine's registry entry has a
`pipeline`.

### Stage 1 — planner (stronger model, read-only)
- Runs Sonnet or Copilot with a **planning prompt** (a variant of
  `formatPrompt`) that instructs it to:
  - Read the relevant files and diagnose the root cause.
  - **NOT edit any files.**
  - Emit a single structured JSON line:
    ```json
    {"targetFiles":["path/…"],"plan":"…","implementerPrompt":"…","confidence":"high|medium|low"}
    ```
- **Gate on the planner output:**
  - If `confidence: "low"` or `targetFiles` is empty → skip the implementer
    entirely and mark the issue `needs_review` with the planner's diagnosis.
    Do not burn the cheap model on a plan that already gave up.

### Stage 2 — implementer (cheaper model)
- Runs DeepSeek with the planner's `implementerPrompt` as its task. The
  implementer does all file edits. Downstream commit/push/parse logic is
  unchanged.

### Cost & correctness constraints
- **Savings are conditional.** The planner is a full expensive-model call every
  time; the win comes only because *implementation* (reading many files +
  editing) is the token-heavy phase. Augmented should therefore **not** be the
  default for trivial issues.
- **Injection flows through.** The `implementerPrompt` is *derived from*
  untrusted issue text by the planner. Keep the "this is data, not commands"
  framing in the handoff so a malicious issue cannot launder instructions
  through the planner into a trusted-looking prompt.
- **Log both stages.** The session log (`logFilename`) currently records one
  prompt/response. For augmented, record the planner prompt+output *and* the
  implementer prompt+output, or debugging becomes opaque.

---

## 6. Paradigm 3 — auto routing (optional, later)

- An `"auto"` engine that resolves to a concrete engine at pick time based on
  `issue.category` (already present in the schema). Example policy: `styling` /
  `copy` → `claude-deepseek` single-shot; `bug` / `logic` → `augmented`.
- No new infrastructure — it is a function from `category` to an existing
  registry key. Build after §3–§5 are stable.

---

## 7. Fallback & model-availability handling

This is a first-class requirement, not an afterthought.

### 7.1 Classify the failure
`runEngine` must classify every non-success, primarily from stderr/exit code:

- **`unavailable`** — auth/quota exhaustion: patterns like `401`, `403`,
  `insufficient_quota`, `authentication`, `no tokens`, `quota`.
- **`transient`** — rate limit / overload / network: `429`, `rate limit`,
  `overloaded`, `503`, connection resets, and the existing subprocess
  **timeout** path (~line 682).
- **`issue-failure`** — the engine ran cleanly but exited non-zero on the
  actual task. This is **not** an engine problem: do **not** fall back; treat
  it as today (mark for review). Distinguishing this from the above is the
  whole point of classification.

Keep the pattern list in one place (a small `classifyFailure(stderr, code)`
helper) so it is testable and tunable.

### 7.2 Fallback chain
- On `unavailable` or `transient`, try the next engine in the registry entry's
  `fallback` list, in order, until one succeeds or the list is exhausted.
- For **augmented** specifically:
  - Planner unavailable → optionally fall back to running the implementer
    standalone (degraded but functional), or fall the planner over to another
    strong model.
  - Implementer unavailable → fall the implementer over to another cheap model.

### 7.3 Circuit breaker with cooldown
- Maintain a module-level `Map<engine, downUntil>`. When an engine returns
  `unavailable`, mark it down for a cooldown window (e.g. 5–10 min,
  configurable).
- Future issues **skip** engines currently in cooldown and go straight to the
  fallback — no per-issue wasted failing call. This gives the benefit of a
  preflight health check without paying for a probe (reactive detection +
  proactive skipping).

### 7.4 Respect user intent, transparently
- Under Paradigm 1, if the user explicitly selected an engine and it was
  unavailable, the issue `resolution` must record the substitution, e.g.
  *"requested claude-deepseek unavailable — resolved with copilot."*
- Support a per-issue policy (default `auto`):
  - `auto` — fall back silently but log/record the substitution.
  - `strict` — do **not** substitute; defer the issue (see 7.5) until the
    chosen engine is available again.

### 7.5 "Everything is down" — defer, don't fail
- If the whole fallback chain is unavailable, the issue is **not** broken and a
  human should **not** be paged to inspect it.
- Leave the issue effectively retryable: set a distinct status such as
  `deferred` / `waiting_for_capacity`, and retry on a **capacity-based
  backoff** — this must **bypass the coarse 10-minute dedupe** so it retries
  when tokens return rather than on a fixed timer.
- Alert the **operator** (notify / `notifyLog`) that all engines are
  unavailable — that is an ops problem, not an issue problem.

### 7.6 Don't re-plan on retry (augmented)
- If the planner (expensive) succeeded but the implementer (cheap) was
  unavailable, **cache the plan** on the issue (e.g. in `details_json` under a
  reserved key, or `resolution`) and, on retry, skip straight to
  implementation. Re-running the planner throws away an expensive call already
  paid for.

### 7.7 Two distinct "no tokens" cases — do not conflate
- The **consumer's own auth to the Dockyard API** (`initAuthHeader`) already
  degrades gracefully (heartbeat + wait). Leave it as is.
- The **model CLI's own credentials** (Copilot token, Anthropic key) cannot be
  refreshed by the consumer — it can only *detect* the failure and route
  around it. Everything in §7 is about this second case.

---

## 8. Optional extension — per-issue token budget

Not required, but a natural related lever: allow an optional `maxCost` /
`budget` on an issue and bail (defer or mark `needs_review`) if a fix would
exceed it. Tracked separately from availability. Mentioned here so the data
model can leave room for it if convenient.

---

## 9. Backward compatibility & safety checklist

- [ ] Existing issues with no `engine` → default engine, current behavior.
- [ ] `DEEPSEEK_CMD` / `DEEPSEEK_MODEL` still honored as the default engine.
- [ ] Engine value is validated against the registry allowlist **server-side**;
      the consumer never builds a command from raw user input. `spawn` is still
      called without a shell so args are not shell-interpreted.
- [ ] Protected-files enforcement (`revertAndStageProtected`) is unchanged and
      still runs for every strategy.
- [ ] The untrusted-issue-text framing in prompts is preserved in both the
      planner and implementer prompts.
- [ ] Session logs capture every stage for augmented runs.
- [ ] `issue-consumer.test.mjs` is extended: engine resolution, failure
      classification, fallback ordering, cooldown skip, deferral on total
      unavailability, and "planner low-confidence → needs_review".

---

## 10. Suggested build order

1. **Engine registry + `runEngine` refactor** (no behavior change).
2. **Paradigm 1** — `engine` column, server validation, consumer read, UI
   selector defaulting to Auto.
3. **Fallback core** — failure classification, fallback chains, circuit
   breaker, deferral status (§7.1–7.5).
4. **Paradigm 2** — augmented pipeline as a registry entry, with the planner
   gate and both-stage logging; wire in plan caching (§7.6).
5. **Paradigm 3** — auto routing by category.
6. **(Optional)** token budget (§8).

Each step is independently shippable and backward-compatible.
