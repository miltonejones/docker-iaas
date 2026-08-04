# API-Key Authentication

Give Dockyard a real, per-user, revocable credential that non-browser clients
(a future CLI, a future MCP server) can authenticate with — without inventing
a new auth model from scratch.

## Context

Today Dockyard's REST API only supports one interactive auth path: browser
JWT login (`POST /api/auth/login`, 7-day token, no revocation). Two
non-interactive mechanisms already exist, but neither fits a CLI or a
per-installation MCP server:

- **Webhook secret** (`x-webhook-secret`, `server/src/auth.ts`'s `webhookAuth`)
  — a single, DB-persisted, rotatable secret, scoped to `/api/github/*` only.
- **Consumer API key** (`x-consumer-api-key`, `CONSUMER_API_KEY` env var) — a
  single shared secret for the whole install, exchanged for a JWT belonging
  to `getFirstUser()`. Not per-user, not revocable, not scoped — fine for the
  one autonomous issue-consumer process it was built for, wrong model for
  "any number of developers/scripts each with their own credential."

This gap adds a proper `api_keys` table and a `dky_`-prefixed bearer token
that `requireAuth` accepts alongside a JWT. It's a prerequisite for
[[17-cli]] (the CLI needs something to authenticate with) and
[[18-mcp-rest-client]] (MCP's `DOCKYARD_API_KEY` env var currently just
checks against the single shared `CONSUMER_API_KEY` — this gap gives it a
real per-installation identity instead), but it's also useful standalone:
once this ships, anyone can `curl` the API with a self-issued key today,
before either of those other two gaps exist.

## Reasoning / design decisions

- **A key acts as its owning user — no separate role/scope column.** The
  `api_keys` table stores no `role`; at request time the key resolves to a
  `user_id`, and that user's current role is looked up fresh via
  `getUserById` (exactly like a JWT does today). This means `requireRole`/
  `requireWrite` need **zero changes** — they only ever look at
  `req.authUser.role`, and that gets populated identically regardless of
  which credential type produced it. A second, driftable copy of role data
  on the key itself would be pure liability with no upside for v1.
- **Hash the key, never store it raw — but don't bcrypt it.** The raw key is
  32 bytes of CSPRNG output (`crypto.randomBytes(32)`), not a human-chosen
  password. Salting/slow-hashing (bcrypt) defends against dictionary and
  rainbow-table attacks on low-entropy secrets — irrelevant here, since
  there's no dictionary of "the user's favorite words" to attack a random
  256-bit token with. A single `sha256(key)` hash with an exact-match DB
  lookup (indexed) is standard practice for API keys (GitHub, Stripe do the
  same) and is simpler and faster than reusing the bcrypt path built for
  passwords.
- **Disambiguate by prefix, not by "try both."** `webhookAuth` already
  demonstrates the "try JWT, fall back to a secondary scheme" shape this
  gap follows — but it tries JWT-verify unconditionally first, which is fine
  when the fallback is a single global secret. For per-key lookups we'd
  rather not waste a `jwt.verify` call (or worse, get a false-positive parse)
  on a value we can already tell isn't a JWT. Prefixing every issued key with
  `dky_` (never a valid JWT shape — JWTs are three dot-separated base64url
  segments) lets `requireAuth` dispatch cleanly: `dky_` → API-key lookup,
  otherwise → JWT verify, matching the existing control flow shape exactly.
- **Soft-delete (`revoked_at`), never hard-delete.** Keeps "last used"/
  audit history intact and matches the `revoked_at IS NULL` filter style
  used for validity checks elsewhere in this codebase, rather than deleting
  rows and losing the record that a key ever existed.
- **No new role or header scheme.** Per this repo's existing constraint
  precedent (see gap/13's prompt), reuse the existing `Authorization: Bearer`
  header and the existing three-role model — this is additive to
  `requireAuth`, not a parallel auth system.

## Key shape

```
dky_<43-char base64url encoding of 32 random bytes>
```

Example: `dky_xY3fQm9K...` (illustrative, not a real key). Stored fields:

```ts
interface ApiKeyRow {
  id: string;            // e.g. "key-<random>"
  user_id: string;        // FK -> users.id
  name: string;            // user-supplied label, e.g. "laptop CLI"
  key_hash: string;        // sha256(rawKey).hex — UNIQUE
  key_prefix: string;      // rawKey.slice(0, 12), display-only, never used for auth
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
```

## Implementation steps

### 1. New table module — `server/src/db/apiKeys.ts`

Follow the existing `server/src/db/audit.ts` pattern (a feature gets its own
module exporting `initXTables(db)` + CRUD functions, rather than more inline
SQL crammed into `db.ts`):

```ts
import type Database from 'better-sqlite3';

let db: Database.Database;

export function initApiKeyTables(database: Database.Database): void {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)');
}

export function createApiKey(id: string, userId: string, name: string, keyHash: string, keyPrefix: string, createdAt: string) { /* INSERT */ }
export function listApiKeysForUser(userId: string) { /* SELECT ... WHERE user_id = ? ORDER BY created_at DESC */ }
export function findApiKeyByHash(keyHash: string) { /* SELECT ... WHERE key_hash = ? AND revoked_at IS NULL */ }
export function touchApiKeyLastUsed(id: string, at: string) { /* UPDATE ... SET last_used_at = ? WHERE id = ? */ }
export function revokeApiKey(id: string, userId: string, revokedAt: string): boolean { /* UPDATE ... SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL; return changes > 0 */ }
```

Wire into `server/src/db.ts`: import `initApiKeyTables` near the other
`db/*` imports and call it from `initDb()` in the same style as
`initAuditTables(db)` — after the `users` table exists (this table has a
`REFERENCES users(id)` FK). No `ALTER TABLE` migration needed; it's a new
table, so `CREATE TABLE IF NOT EXISTS` is the whole migration.

### 2. Key generation/hashing helper — `server/src/services/apiKeys.ts`

```ts
import crypto from 'node:crypto';
import * as db from '../db/apiKeys.js';
import { getUserById } from '../db.js';
import { HttpError } from './HttpError.js';

const KEY_PREFIX = 'dky_';

function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export function list(userId: string) {
  return db.listApiKeysForUser(userId).map(({ key_hash, ...rest }) => rest); // never return the hash
}

export function create(userId: string, name: string) {
  if (!name?.trim()) throw new HttpError(400, 'A name is required.');
  const rawKey = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  const id = `key-${crypto.randomBytes(9).toString('base64url')}`;
  const createdAt = new Date().toISOString();
  db.createApiKey(id, userId, name.trim(), hashKey(rawKey), rawKey.slice(0, 12), createdAt);
  return { id, name: name.trim(), key: rawKey, keyPrefix: rawKey.slice(0, 12), createdAt };
}

export function revoke(userId: string, id: string) {
  if (!db.revokeApiKey(id, userId, new Date().toISOString())) {
    throw new HttpError(404, 'API key not found.');
  }
  return { ok: true };
}

/** Called from requireAuth. Returns the resolved user, or undefined if the
 *  key is unknown/revoked. Updates last_used_at on success (best-effort). */
export function authenticate(rawKey: string) {
  const row = db.findApiKeyByHash(hashKey(rawKey));
  if (!row) return undefined;
  const user = getUserById(row.user_id);
  if (!user) return undefined;
  db.touchApiKeyLastUsed(row.id, new Date().toISOString()); // fire-and-forget, best-effort
  return { userId: user.id, email: user.email, role: user.role };
}
```

### 3. Extend `requireAuth` — `server/src/auth.ts`

```ts
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : queryToken;
  if (!token) {
    res.status(401).json({ error: 'Authorization header required.' });
    return;
  }

  if (token.startsWith('dky_')) {
    const user = apiKeyService.authenticate(token);
    if (!user) {
      res.status(401).json({ error: 'Invalid or revoked API key.' });
      return;
    }
    req.authUser = user;
    next();
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET!) as unknown as AuthUser;
    const user = getUserById(payload.userId);
    if (!user) { res.status(401).json({ error: 'User not found.' }); return; }
    req.authUser = { userId: user.id, email: user.email, role: user.role as AuthUser['role'] };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}
```

Give `optionalAuth` the same `dky_` branch for consistency (cheap, avoids a
silent auth gap if something later mixes `optionalAuth` with a machine
client). `webhookAuth` does **not** need changes — API keys are scoped to
`requireAuth`-protected routes, not the separate `/api/github/*` webhook
path.

### 4. New routes — `server/src/routes/apiKeys.ts`

Mounted as its own router (matching how `projects.ts`/`gateway.ts` etc. are
each their own file, rather than piling onto the already-busy
`routes/auth.ts`):

```ts
export const apiKeysRouter = Router();

apiKeysRouter.get('/', (req, res) => {
  res.json(apiKeyService.list(getAuthUser(req)!.userId));
});

apiKeysRouter.post('/', (req, res) => {
  const { name } = req.body as { name?: string };
  res.status(201).json(apiKeyService.create(getAuthUser(req)!.userId, name ?? ''));
});

apiKeysRouter.delete('/:id', (req, res) => {
  apiKeyService.revoke(getAuthUser(req)!.userId, req.params.id);
  res.json({ ok: true });
});
```

Mount in `server/src/index.ts`:

```ts
app.use('/api/api-keys', requireAuth, apiKeysRouter);
```

No `requireRole` gate at the router level — every authenticated user
(including `viewer`) manages *their own* keys; `revoke`'s `WHERE user_id = ?`
clause is the ownership check, and returns 404 (not 403) if the key belongs
to someone else, so key IDs don't leak existence across users.

### 5. Minimal Settings UI — `web/src/pages/Settings.tsx`

Add an "API Keys" panel modeled directly on the existing "Webhook Secret"
section in the same file (list + copy-to-clipboard UX already exists there
to crib from) — with one key difference: a webhook secret can be re-fetched
and shown again on demand (it's not hashed at rest), an API key **cannot**
(it's hashed at rest by design). The UI must say so explicitly:

- Table: name, created date, last-used date ("never" if null), a per-row
  "Revoke" button.
- "Create key" → prompt for a name → `POST /api/api-keys` → show the raw
  key **once**, in a dismissible banner/modal with copy-to-clipboard and
  copy text like *"Copy this now — it won't be shown again."*
- No admin gate — this panel is for every user, unlike the adjacent
  admin-only "Users" section.

Add matching client calls to `web/src/api.ts`:

```ts
apiKeyList: () => fetch('/api/api-keys').then(json),
apiKeyCreate: (name: string) => fetch('/api/api-keys', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) }).then(json),
apiKeyRevoke: (id: string) => fetch(`/api/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(json),
```

## Files summary

| File | Change |
|---|---|
| `server/src/db/apiKeys.ts` | New — `api_keys` table + CRUD |
| `server/src/db.ts` | Wire in `initApiKeyTables` |
| `server/src/services/apiKeys.ts` | New — key generation, hashing, `authenticate()` |
| `server/src/services/HttpError.ts` | (existing — reused, no change) |
| `server/src/auth.ts` | `requireAuth`/`optionalAuth` gain the `dky_` branch |
| `server/src/routes/apiKeys.ts` | New — list/create/revoke endpoints |
| `server/src/index.ts` | Mount `/api/api-keys` |
| `web/src/api.ts` | `apiKeyList`, `apiKeyCreate`, `apiKeyRevoke` |
| `web/src/pages/Settings.tsx` | New "API Keys" panel |

## Constraints

- Do NOT touch `webhookAuth`, `CONSUMER_API_KEY`, or the consumer-key
  exchange endpoint (`POST /api/auth/consumer`) — those stay exactly as-is;
  this is a new, separate credential type, not a replacement.
- Do NOT add a `role`/`scopes` column to `api_keys` for v1 — a key inherits
  its owner's live role. Revisit only if a real need for narrower-than-user
  scoping shows up later.
- Do NOT store the raw key anywhere after the create response is sent —
  no logging it, no writing it to any other table.
- Match existing code style: service/route split, `HttpError` for expected
  failures, ESM imports with `.js` extensions.
- Add a test file `server/src/services/apiKeys.test.ts` covering
  hash-and-lookup round-trip and revocation (new security-relevant logic —
  cheap to test even though most route files in this repo rely on manual
  verification).
- Run `npm run typecheck` and `npm run lint` after changes.

## Testing plan

Manual, against a throwaway `PORT=` dev instance (this repo's standing
protocol: it shares the real SQLite/Docker/MinIO state, so clean up any test
data created):

1. Log in as an existing user, `POST /api/api-keys {"name":"test-key"}` —
   confirm `201` with a `dky_`-prefixed key returned exactly once; confirm
   the DB row has a `key_hash`, never the raw key
   (`sqlite3 data/iaas.db "select id,name,key_prefix,revoked_at from api_keys"`).
2. `curl -H "Authorization: Bearer dky_..." /api/containers` — confirm `200`,
   same as a JWT would return; confirm `last_used_at` updates.
3. `curl -H "Authorization: Bearer dky_bogus"` — confirm
   `401 {"error":"Invalid or revoked API key."}`.
4. `DELETE /api/api-keys/:id`, repeat step 2 — confirm `401` (revoked keys
   stop working immediately).
5. Confirm existing JWT login/web-console flows are unaffected.
6. Create a key for a `viewer`-role user, confirm write-gated endpoints
   (`requireWrite`) still reject with `403` using that key.
7. Clean up test keys (revoke, or leave revoked rows — they're inert) and
   stop the throwaway server process.
