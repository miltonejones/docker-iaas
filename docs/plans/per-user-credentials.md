# Prompt: Per-user credentials — every key is provided by the user and scoped to them

**Repo:** `miltonejones/docker-iaas` · **Base branch:** `main` · **Deliverable:** a per-user
encrypted credential store, per-user resolution wired into every credential-using path, a
write-only credentials UI, and a migration that removes the shared secrets from compose.

## Objective

Replace the current model — the server holds **shared** external-service credentials (in Docker
secrets / env) that the operator, the LLM assistant, and the autonomous consumer all use — with:
**each user supplies their own credentials, which are stored encrypted and used only for that
user's actions.** No user-facing external credential is baked into `docker-compose.yml` anymore.

## Decisions (already made — build to these)

1. **Target model: single-operator now, per-user shape.** There is one user today, but store and
   resolve credentials **per `user_id`** so the design already works if users are added later.
   Don't build a full multi-tenant RBAC layer — just per-user credential ownership.
2. **Trust model: server-held master key.** Per-user secrets are encrypted at rest with the
   **existing server master key**, so the server can decrypt them to act on the user's behalf,
   including in background/autonomous flows. (This is the accepted trade-off: the master key is
   the crown jewel; its compromise exposes all stored secrets.)
3. **Consumer uses the issue owner's stored credentials.** When the autonomous consumer fixes an
   issue, it acts with the **reporting user's** stored GitHub token (resolved server-side via the
   master key), not a shared token.

## Scope — which credentials become per-user

Per-user (user-supplied, encrypted, resolved by acting user):
- **LLM key** — Anthropic *or* DeepSeek API key (per the user's chosen provider).
- **GitHub token** — for the github tools and the consumer's clone/commit/push.
- **AWS credentials** — access key / secret / region, for Route 53 DNS automation.
- **Database connections** — already per-user (`database_connections` has `user_id`); keep, and
  fold their encryption into the same store/pattern for consistency.

Stays server-side infra (NOT per-user): the **JWT signing secret**, the **DB-encryption master
key** (it's the key that protects the per-user secrets), and **MinIO** root creds (storage
backend). These are not user credentials.

## Current state (what to replace)

The credential reads to migrate — all currently global:
- `server/src/routes/assistant.ts` builds a **module-level singleton**
  `const client = new Anthropic({ apiKey: resolveApiKey(PROVIDER) })` from env/secret at import.
- `server/src/route53.ts` `getClient()` builds a **singleton** `Route53Client` from
  `readAwsSecret(...)` (env / `/run/secrets`).
- `server/src/githubAssistantTools.ts` `resolveGithubToken()` reads env / `/run/secrets`
  (used in ≥3 call sites, incl. the consumer path).

The at-rest encryption to reuse:
- `server/src/databaseManagement.ts` — `readMasterSecret()` (from
  `/run/secrets/dockyard_database_master_key`) + `crypto.createCipheriv('aes-256-gcm', …)`.
  **Reuse this exact pattern** for the new store; do not invent a second crypto scheme.

## Design & implementation

### 1. Encrypted credential store  (`server/src/db/credentials.ts`)
- Table `user_credentials(user_id TEXT, provider TEXT, ciphertext TEXT, iv, tag, updated_at,
  PRIMARY KEY(user_id, provider))` — `provider` ∈ `anthropic | deepseek | github | aws`.
  (Store AWS as one JSON blob: `{accessKeyId, secretAccessKey, region}`.)
- Encrypt/decrypt with the master-key AES-256-GCM helper factored out of
  `databaseManagement.ts` (extract a shared `encryptSecret/decryptSecret` so both call sites use
  one implementation).
- Helpers: `setUserCredential(userId, provider, plaintext)`, `getUserCredential(userId,
  provider): string | undefined` (decrypts), `listUserCredentialMeta(userId)` (provider +
  last-4 + updatedAt, **never** plaintext), `deleteUserCredential(userId, provider)`.

### 2. Per-user resolution (drop the global singletons)
- **Assistant:** construct the Anthropic/DeepSeek client **per session/request** from the acting
  user's key (`getUserCredential(userId, provider)`), not a module singleton. If the user has no
  key, return a clear, actionable error (`"Add your <provider> API key in Settings"`), not a
  silent fallback.
- **Route 53:** make `getClient()` take resolved creds; build the `Route53Client` per operation
  from the acting user's AWS credential blob. Remove the module-level singleton (or key a small
  cache by userId).
- **GitHub:** change `resolveGithubToken()` → `resolveGithubToken(userId)`; thread the acting
  user through the github tools. Update the "no token" error to point at Settings.
- **Acting user** = `getAuthUser(req)?.userId` for interactive API calls; for the consumer, the
  **issue's `user_id`** (see §5).

### 3. Credentials API  (`server/src/routes/credentials.ts`, `requireAuth`)
- `GET /api/credentials` → metadata only (`[{provider, last4, updatedAt, configured}]`).
- `PUT /api/credentials/:provider` → set/replace (write-only; never echoes the value back).
- `DELETE /api/credentials/:provider` → remove.
- Audit every set/delete via `recordAuditLog`.

### 4. Settings UI  (web)
- A Settings/Credentials screen: one field per provider, masked, showing "configured · ••••1234 ·
  updated <when>"; save is write-only; a Remove button. Never render a stored secret back.

### 5. Consumer → issue owner's credentials
- The consumer runs as its own container and must obtain the **issue owner's** decrypted GitHub
  token (and any needed keys). Add an **internal, tightly-gated** resolution path: an endpoint
  like `GET /api/internal/credentials?userId=…&provider=github` that returns the decrypted value,
  gated by the existing consumer pre-shared key (`CONSUMER_API_KEY`) and reachable only over the
  internal Docker network. This endpoint returns plaintext secrets — treat it as a sensitive
  surface: consumer-key required, never mounted publicly (Caddy must not expose `/api/internal`),
  and audited on every call. Resolve the issue's `user_id` from the issue record.

### 6. Migration / bootstrap (no downtime, no lockout)
- On first boot after deploy: if the operator (first) user has **no** stored credentials but the
  legacy env/secret values are present, **import them once** into that user's store, then prefer
  the store.
- Keep a **transition fallback**: if a user has no stored credential for a provider, fall back to
  the legacy env/secret (with a warning log) so nothing breaks mid-migration. Once the operator
  has saved their keys, **remove the shared secrets** for these user-facing services
  (`anthropic_api_key`, `deepseek_api_key`, `github_token`, `AWS_*`) from `docker-compose.yml`;
  the JWT secret, DB master key, and MinIO stay.

## Security guardrails

- Secrets are **write-only** over the API — list/return metadata + last-4 only, never plaintext.
- Reuse the master-key AES-256-GCM scheme; per-row random IV; store the GCM auth tag; consider a
  per-user salt/AAD binding the ciphertext to `user_id`.
- `recordAuditLog` on credential set/delete **and** on every internal consumer resolution.
- `/api/internal/*` must be unreachable from the public edge (verify Caddy/base config never
  routes it) and gated by `CONSUMER_API_KEY`.
- Missing-credential paths fail **closed** with an actionable message — never silently fall back
  to another user's or a shared credential (except the one-time, logged migration fallback in §6).

## Acceptance criteria

- No user-facing external credential (`anthropic/deepseek/github/AWS`) is required in
  `docker-compose.yml`; the app runs with them supplied per-user via Settings.
- The assistant, DNS automation, and github tools each use the **acting user's** stored
  credential; with none configured, they return a clear "configure in Settings" error.
- The consumer fixes an issue using the **issue owner's** stored GitHub token, resolved via the
  gated internal path, and audited.
- Credentials are never returned in plaintext by any API; set/delete are audited.
- `npm test` green (add: store round-trip encrypt/decrypt, per-user resolution precedence over
  legacy fallback, credentials API write-only behaviour, and the internal endpoint's auth gate).

## Sequencing

1. Store + shared crypto helper + `credentials` API + tests.  2. Wire per-user resolution into
github, Route 53, then the assistant (assistant is the biggest change — a singleton today).
3. Consumer internal resolution path.  4. Settings UI.  5. Migration/bootstrap + remove shared
secrets from compose.

## Open questions

- **DeepSeek/Anthropic provider selection** is currently global (`ASSISTANT_PROVIDER`). Should the
  provider choice also become per-user (derived from which key the user saved)? Recommended: yes —
  infer provider from the stored key.
- **Model IDs** (`ANTHROPIC_MODEL`, etc.) — keep as server defaults, or also per-user? Recommended:
  server defaults for now.

## Out of scope / follow-ups

- Full multi-tenant RBAC / sharing of credentials between users.
- User-derived (password-wrapped) encryption — explicitly rejected in favour of the server-held
  master key so background/autonomous flows keep working.
- Secret rotation workflows and external secret managers (Vault/KMS).
