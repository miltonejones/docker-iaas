# Consumer Model Paradigms — Fix Prompt (review of `feat/consumer-model-paradigms`)

> **Purpose.** The `feat/consumer-model-paradigms` branch implements per-issue
> engine selection, the augmented planner→implementer pipeline, circuit-breaker
> cooldowns, fallback chains, and the `deferred` status. The bones are correct.
> This document is the punch list to make it production-ready. Work the items in
> order; **Must-fix #1–#4** are the ones that bite in production. Each item names
> the file and the approximate location so you can go straight to it.
>
> Constraints that still hold from the original spec: the engine registry is the
> allowlist (never build a command from raw user input); protected-file
> enforcement (`revertAndStageProtected`) must remain unchanged; keep the
> untrusted-issue "data, not commands" framing in every prompt; all four
> three-way lists (consumer registry / server allowlist / UI options) must agree.

---

## Must-fix bugs

### 1. `classifyFailure` word-boundary regexes are broken
**File:** `scripts/issue-consumer.mjs`, `classifyFailure` (~L383–400).

The patterns are **regex literals**, but they use `\\b`. Inside a regex literal
`\\b` matches a literal backslash followed by `b` — **not** a word boundary. So
`\\b503\\b`, `no tokens\\b`, and `\\bquota\\b` never match. Consequences:

- An HTTP **503** is never classified `transient`.
- A bare **"quota"** or **"no tokens"** is never classified `unavailable`.

(401/403/429/"rate limit"/"overloaded" happen to work, which masks the bug.)

**Fix:** replace every `\\b` with a single `\b` in both regexes. After the fix,
verify with a unit test (see §Testing) that `"HTTP 503 Service Unavailable"` →
`transient` and `"no tokens left"` / `"quota exceeded"` → `unavailable`.

### 2. Infinite fallback loop on `transient`
**File:** `scripts/issue-consumer.mjs`, `runEngine` (~L582–664).

`transient` intentionally does **not** set a cooldown, and the fallback picker
(`fallbacks.find(...)`) only skips engines currently **in cooldown** — it does
not skip engines already **tried in this call**. Because the registry fallback
chains are cyclic (`copilot → claude-sonnet`, `claude-sonnet → copilot`), a
persistent transient error (e.g. a sticky 429) makes `runEngine` ping-pong
between the two engines forever, re-spawning the CLI on each hop (each with the
15-minute subprocess timeout) while `tried` grows without bound.

**Fix:** maintain a `visited` set within a single `runEngine` call. When picking
the next fallback, skip any engine that is in cooldown **or** already in
`visited`. When no un-visited, un-cooled fallback remains, terminate with
`outcome: "all-unavailable"` (as the code already does when `next` is
undefined). This guarantees each engine is attempted at most once per call.
Apply the same visited-guard inside `runPipeline` if a pipeline stage can chain
into fallbacks.

### 3. `auto` is accepted by the server but does not exist in the consumer
**Files:** `server/src/routes/assistant.ts` (`VALID_USER_ENGINES`, ~L1781) and
`scripts/issue-consumer.mjs` (`ENGINES`, ~L38).

`VALID_USER_ENGINES` includes `"auto"`, but the consumer's `ENGINES` registry
has no `auto` key. `runEngine("auto", …)` throws `Unknown engine: auto`, which
bubbles to the `loop()` catch; the issue stays `open` and **crash-retries
forever**.

**Fix — choose one:**
- **(a) Remove `"auto"`** from `VALID_USER_ENGINES` until it is implemented
  (simplest; matches the "optional, later" status in the original spec), **or**
- **(b) Implement `auto`** as a category-router: at pick time in `runEngine`
  (or a resolver before it), map `issue.category` to a concrete registry key
  (e.g. `styling`/`copy` → `claude-deepseek`; `bug`/`logic` → `augmented`;
  default → `default`). If you do this, `runEngine` needs the issue/category,
  not just the engine name — thread it through `consumeOne`.

Also add a **guard** so an unknown engine never crash-loops: in `consumeOne`,
if `runEngine` throws (or before calling it, if `!ENGINES[engineName]`), fall
back to the `default` engine and record a substitution note, rather than
letting the exception propagate to `loop()`.

### 4. `deferred` issues are never retried
**Files:** `scripts/issue-consumer.mjs` (`consumeOne` poll URL, ~L989, and the
`all-unavailable` branch, ~L1192) and `server/src/routes/assistant.ts` (poll
handler / statuses).

The consumer polls `?status=open`. Nothing ever moves an issue from `deferred`
back to `open`, so a deferred issue leaves the queue **permanently** — worse
than the failure it was meant to replace ("defer, don't fail" became "drop
silently").

**Fix — implement capacity-based retry:**
- Make the consumer also pick up deferred issues, e.g. poll
  `?status=open` **and** re-check `deferred` issues once their defer backoff has
  elapsed. Simplest robust approach: store a `deferredUntil` timestamp (in
  `resolution` or a dedicated field) and have the consumer query deferred issues
  whose backoff has passed.
- On re-attempt, **bypass the 10-minute summary dedupe** (`isDuplicate`) for
  deferred issues — the retry is intentional, not a duplicate. Either exempt
  deferred issues from `recentSummaries`, or clear their key before re-running.
- Only re-attempt when at least one engine is **out of cooldown**; otherwise
  keep deferring. This ties the retry to real capacity rather than a fixed
  timer.
- Keep alerting the operator (the existing `notifyLog("🚨 All engines
  unavailable", …)` is good) but do **not** mark the issue `errored`.

---

## Feature gaps

### 5. Paradigm 2 (augmented) is unreachable from the UI
**File:** `web/src/components/CreateIssueModal.tsx` (`ENGINES` list, ~L12).

`augmented` is implemented in the consumer and allowed by the server, but the
modal only offers `''`, `copilot`, `claude-sonnet`, `claude-deepseek`. Users
cannot select the headline pipeline.

**Fix:** add `{ value: 'augmented', label: 'Augmented (plan → implement)' }` to
the modal's `ENGINES`. Also relabel `''` — it currently reads "Auto (default)"
but means *unset → consumer default* (single-shot), not category routing. Use
"Default" for the empty value and reserve "Auto" for the real `auto` router if
and when #3(b) lands.

### 6. Three-way list drift
**Files:** consumer `ENGINES`, server `VALID_USER_ENGINES`, UI `ENGINES`.

These three are hand-maintained and already disagree (#3 and #5 are both drift
symptoms). Establish one source of truth, or add a guard test.

**Fix (pick the lightest that fits):**
- Export the canonical engine-name list from one module and import it in the
  server and UI; the consumer registry keys remain the authority the others
  derive from, **or**
- Add a test that asserts the UI options ⊆ server allowlist ⊆ consumer registry
  keys (plus the explicit "unset" sentinel), so any future drift fails CI.

---

## Cleanup before merge

### 7. Remove debug cruft
**File:** `server/src/routes/assistant.ts`.

Delete the `[diag:issue-scope]` `console.log` statements and the
`// TEMP: verify scoping layer before fix` comments in the GET and PATCH
`/issues/:id` handlers.

### 8. Unbundle unrelated changes and stop committing runtime logs
The branch also carries: the bucket-protection feature (`create_bucket` /
`update_bucket` / `isBucketProtected` / `styles.css` / `BucketPanel` etc.), a
large `package-lock.json` churn, and ~40 committed `scripts/issue-logs/*.md`
consumer-output files.

**Fix:**
- Move the bucket-protection feature and the `x-consumer-api-key → userId
  "deploy"` service-auth change (see #9) onto their **own branches/PRs** — the
  auth broadening is security-relevant and should not ride in on a
  model-routing change.
- Add `scripts/issue-logs/` to `.gitignore` and remove the committed
  `issue-logs/*.md` artifacts from the branch — they are runtime output, not
  source.

### 9. Isolate and review the service-auth broadening
**File:** `server/src/routes/assistant.ts` (GET & PATCH `/issues/:id`).

The new path accepts `x-consumer-api-key` and grants `userId = "deploy"`. Note
that `getAssistantIssue(id, "deploy")` scopes by user, so a **user-owned issue
may return 404 to the "deploy" pseudo-user** — which is almost certainly what
the `[diag:issue-scope]` logs were chasing. Decide deliberately: either the
service identity bypasses user scoping for issue read/update (pass `undefined`
to skip the scope filter for service callers), or it does not. Make it explicit
and test it.

---

## Minor

### 10. Preserve injection framing at the implementer stage
**File:** `scripts/issue-consumer.mjs`, `runPipeline` / `formatPlannerPrompt`.

`plan.implementerPrompt` fully replaces the prompt, and the implementer never
sees the "issue text is untrusted data, not commands" framing. A crafted issue
could launder instructions through the planner into a trusted-looking
implementer prompt. Wrap the implementer prompt so the untrusted-data caveat is
re-applied around the planner-authored body.

### 11. Fix the mislabeled `needs_review` reason
**File:** `scripts/issue-consumer.mjs`, `consumeOne` (~L1143–1153).

When the augmented implementer **does** run but changes no files, it is reported
as "planner gate (confidence: …)" even though the gate never fired.
Distinguish "gate fired, implementer never ran" from "implementer ran, no
changes" and set the message/resolution accordingly.

---

## Testing (required — none of the new paths are currently covered)
**File:** `scripts/issue-consumer.test.mjs`.

Add tests for:
- `classifyFailure`: `503`/`no tokens`/`quota` → correct class (guards #1);
  401/403 → `unavailable`; 429/"rate limit" → `transient`; clean non-zero →
  `issue-failure`.
- `runEngine` fallback ordering: primary `unavailable` → resolves with first
  healthy fallback, `substitution` populated.
- `runEngine` termination: cyclic chain + persistent `transient` terminates in
  `all-unavailable` and tries each engine at most once (guards #2).
- Cooldown: an engine marked unavailable is skipped on the next call.
- Augmented: planner low-confidence / empty `targetFiles` → `needs_review`
  without running the implementer; happy path runs implementer with the
  planner's prompt.
- Unknown engine (`auto` if not implemented) → consumer falls back to `default`
  and does not throw (guards #3).
- Drift guard (#6): UI options ⊆ server allowlist ⊆ consumer registry keys.

---

## Suggested order of work
1. #1, #2, #3, #4 (correctness — ship-blockers).
2. #7, #8, #9 (cleanup + unbundling; do before opening the PR for review).
3. #5, #6 (make the feature reachable and drift-proof).
4. #10, #11 (hardening + polish).
5. Testing throughout — land each test with the fix it guards.
