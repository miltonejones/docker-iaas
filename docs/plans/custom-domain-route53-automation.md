# Prompt: Automate Route 53 DNS for custom-domain gateway routes

**Repo:** `miltonejones/docker-iaas` · **Base branch:** `main` (this builds directly on the
custom-domain feature merged in PR #58) · **Deliverable:** a working, tested implementation
behind a runtime capability check, plus a small amount of documentation.

---

## Objective

Let a user point a **subdomain of one of their existing Amazon Route 53 hosted zones**
(new or existing subdomain) at a Dockyard gateway route with a **single "Enable" action** —
Dockyard creates the DNS record for them and TLS comes up automatically. This replaces the
current manual step where the user has to go to their DNS provider and hand-create a record.

Concretely, for a user who owns the hosted zone `ktunes.app` in Route 53:

> Setting the domain `start.ktunes.app` on the `ktunes` route and clicking **Enable** should,
> with no further manual DNS work, make `https://start.ktunes.app/` serve that route.

## Why this is needed (current state after PR #58)

PR #58 shipped the foundation and it is on `main`:

- `routes.domain` / `routes.domain_verified` columns + `getRouteByDomain`, `setRouteDomain`,
  `verifyRouteDomain`, `getRouteByDomainAnyStatus` (`server/src/db.ts`).
- Host-based routing middleware in `server/src/index.ts` (matches `req.hostname` → route,
  records `entry_point = 'custom_domain'` telemetry).
- `server/src/caddy.ts` — `appendCaddySite` / `removeCaddySite` / `reloadCaddy` (Caddy is the
  edge and provisions TLS via ACME automatically once DNS resolves to it).
- Domain API on `server/src/routes/gateway.ts`: `PATCH /:id/domain`, `POST /:id/domain/enable`,
  `GET /:id/domain/status`, `DELETE /:id/domain`.
- Assistant tools `update_gateway_route` and `manage_gateway_domain` (dispatched client-side in
  `web/src/components/AssistantBar.tsx`).

**The gap:** `GET /:id/domain/status` only returns a *manual* instruction string
("Create a CNAME record pointing `<domain>` to dockyard.ai…") and `enable` does nothing with
DNS. For domains hosted in Route 53 we can and should do the DNS change for the user.

## Scope for this iteration

**In scope**
- Subdomains (new or existing) of an **existing public** Route 53 hosted zone the deployment's
  AWS credentials can see.
- Create/UPSERT the routing record (a `CNAME` to the Dockyard edge host) via Route 53.
- Let Caddy obtain the TLS cert automatically (already wired) once the record resolves.
- Clean teardown: on domain removal, delete the record **only if Dockyard created it**.
- Preserve the existing **manual-instructions fallback** for domains not in Route 53 — no
  regression for those.

**Out of scope (leave as documented follow-ups)**
- Apex/zone-root domains (e.g. `ktunes.app` itself) — a `CNAME` is illegal at the apex; this
  needs an `A`/`ALIAS` record and a stable edge IP. Reject apex with a clear error for now.
- Non-Route-53 DNS providers (keep the manual path).
- ACM + CloudFront issuance (Caddy handles TLS; the ACM/CloudFront path from the original plan
  is a separate track).
- Cross-account role assumption.

---

## Prerequisite decision — how does Dockyard authenticate to Route 53?

This is unresolved and the maintainer is unsure what the deployed host provides. **Do not
hard-code an assumption.** Instead, make capability *discoverable at runtime* and degrade
gracefully:

1. **Step 0 — read-only preflight (build this first).** Add a capability probe that calls
   `route53:ListHostedZones` using the AWS SDK's **default credential provider chain**
   (environment variables, shared config file, and — importantly — an EC2/ECS instance role if
   the box has one). The probe answers three questions empirically: *are credentials present?*,
   *does a hosted zone match this domain?*, and *what's the zone id?* This is how we find out
   "what's available" without guessing, and it is safe (no writes).

2. **Credential resolution order:**
   - Default provider chain (ambient env / instance role) — preferred, no secrets stored.
   - Optional fallback: per-deployment AWS credentials entered in a settings screen and stored
     **encrypted at rest**, reusing the existing DB-credential encryption pattern
     (see how `database_connections` / `encrypted_config` are handled). Only add this if the
     ambient path proves unavailable — keep it behind the preflight.
   - Region from `AWS_REGION` (default `us-east-1`; Route 53 is a global service but the SDK
     still needs a region configured).

3. **Branch on the preflight result at enable time:**
   - Credentials present **and** a hosted zone matches → **automated path** (UPSERT the record).
   - Otherwise → **manual path** (return the existing DNS instructions; unchanged behavior).

4. **Least-privilege IAM** — document the minimal policy the credentials need and no more:
   `route53:ListHostedZones`, `route53:ListResourceRecordSets`,
   `route53:ChangeResourceRecordSets` (scoped to the specific hosted zone ARNs), and optionally
   `route53:GetChange` for propagation polling.

---

## Implementation steps

1. **Dependency.** Add `@aws-sdk/client-route-53` to `server/package.json` (the repo already
   uses `@aws-sdk/client-s3`; match the major version line).

2. **New module `server/src/route53.ts`.** Keep AWS access typed and centralized here — never a
   shell/CLI passthrough. Make the Route 53 client injectable so tests can mock it. Export:
   - `route53Preflight(): Promise<{ available: boolean; zones: HostedZone[]; error?: string }>`
   - `findHostedZoneForDomain(domain, zones): HostedZone | undefined` — **longest-suffix match**
     of the domain against zone names (normalize trailing dots; the most specific zone wins,
     e.g. `a.b.example.com` prefers zone `b.example.com` over `example.com`).
   - `upsertCname(zoneId, recordName, target, ttl): Promise<{ changeId: string }>` — a
     `ChangeResourceRecordSets` `UPSERT` of a single `CNAME`.
   - `deleteCname(zoneId, recordName, target): Promise<void>` — `DELETE` for teardown; must
     match the exact name/type/value Dockyard created.
   - (optional) `waitForChangeInSync(changeId)` using `GetChange`.

3. **Preflight surface.** Add `GET /api/gateway/:id/domain/preflight` (or extend the existing
   `/domain/status` payload) to return, for the route's current domain: whether automation is
   available, the matched zone name/id (if any), whether the record already exists and where it
   points, and whether the domain is an apex (blocked). The frontend uses this to show
   "We can set this up automatically" vs the manual instructions.

4. **Enable flow (`POST /:id/domain/enable`).** Extend the existing handler:
   - Reject apex domains (domain equals a hosted-zone name) with a clear message.
   - Run the preflight. If a zone matches → `upsertCname(zoneId, domain, EDGE_HOST, ttl)`,
     then `appendCaddySite(domain)` + `await reloadCaddy()`, then `verifyRouteDomain(id)` and
     record that DNS is Dockyard-managed (see step 6). Return the active status.
   - If no zone matches / no creds → keep the current manual-instructions response unchanged.

5. **Disable flow (`DELETE /:id/domain`).** If the record was Dockyard-managed, call
   `deleteCname(...)` (best-effort; tolerate "already gone") **before** `removeCaddySite` +
   `setRouteDomain(id, null)`. Never delete a record Dockyard didn't create.

6. **Data model.** Add columns to `routes` (follow the existing `try { ALTER TABLE … } catch`
   migration style in `initDb`):
   - `domain_dns_managed INTEGER DEFAULT 0` — 1 when Dockyard created the DNS record (governs
     teardown).
   - `domain_hosted_zone_id TEXT` — the zone id used, so teardown targets the right zone.
   Add matching helpers (e.g. `setRouteDomainDnsManaged(id, zoneId)` / clear on removal) and
   include the fields in `toJson` where useful.

7. **Edge target & record type.** The CNAME value is the Dockyard edge host — read from
   `DOCKYARD_EDGE_HOST` (default `dockyard-ai.com`) rather than hard-coding, so staging works.
   Use a short TTL (e.g. 300s) so mistakes are cheap to correct. Subdomain-only (CNAME) this
   iteration.

8. **Verification / cert timing.** Do **not** block `enable` on ACME issuance. Once the record
   is created and the Caddy site is present, mark the domain verified so host routing starts;
   Caddy performs on-demand TLS on the first HTTPS request. Optionally poll `GetChange` until
   `INSYNC` before returning, but keep it bounded and non-fatal.

9. **Guardrails / safety.**
   - Only ever touch records inside a zone the credentials actually own (from the preflight
     list) — never construct a zone id from user input.
   - Multi-tenant: keep the existing per-user ownership checks on the route; decide and enforce
     who is allowed to claim a subdomain of a shared zone (see open questions).
   - If an existing record for the subdomain already points somewhere else, require the caller
     to opt into overwriting rather than silently clobbering it.
   - Keep the 409 "already claimed" message generic to avoid leaking another tenant's route name
     (a carry-over review nit).

10. **Assistant integration (safe).** Extend `manage_gateway_domain` so the `enable`/`status`
    actions reflect the automated path, and surface the preflight result. **Do not** reintroduce
    a raw `run_aws_command`/CLI tool — all AWS access stays behind the typed, least-privilege
    endpoints above.

11. **Config & docs.** Document `AWS_REGION` and `DOCKYARD_EDGE_HOST` (and any stored-credential
    settings) in the `docker-compose.yml` comment block and `README.md`, plus the minimal IAM
    policy JSON.

## API surface (summary)

| Method | Path | Change |
|--------|------|--------|
| GET | `/api/gateway/:id/domain/preflight` | **new** — automation availability + matched zone + record state |
| POST | `/api/gateway/:id/domain/enable` | UPSERT Route 53 record when a zone matches, else manual fallback |
| DELETE | `/api/gateway/:id/domain` | delete the managed record before teardown |
| GET | `/api/gateway/:id/domain/status` | include `dnsManaged` + zone info |

## Testing

- Unit-test `findHostedZoneForDomain` (longest-suffix match, trailing-dot normalization, apex
  detection, no-match) and the `ChangeResourceRecordSets` change-batch construction with a
  **mocked Route 53 client** — no live AWS. Follow the repo's `node:test` + in-memory-DB
  convention (see `server/src/*.test.ts`).
- Test the enable/disable branch selection: zone-match → automated (mock client asserts the
  UPSERT), no-match/no-creds → manual instructions, apex → rejected.
- Note: some CI/sandbox environments block egress to `*.amazonaws.com`; all tests must run
  offline against mocks. Live Route 53 calls only happen in a real deployment.

## Acceptance criteria

- With ambient AWS credentials that own the `ktunes.app` zone: setting `start.ktunes.app` and
  clicking Enable creates the CNAME, brings up TLS via Caddy, and `https://start.ktunes.app/`
  serves the route — no manual DNS step.
- Removing the domain deletes the Dockyard-created record and leaves other records untouched.
- With no AWS credentials (or a non-Route-53 domain), behavior is exactly today's manual flow —
  no regression.
- Apex domains are rejected with an actionable message.
- `npm run typecheck` and `npm run test` pass; new logic is covered by offline tests.

## Open questions to confirm with the maintainer before/while implementing

1. **Credentials:** does the deployed host already have AWS access (instance role / env), or
   should Dockyard store user-supplied keys? (Preflight in step 1 answers this empirically, but
   the intended production mechanism should be confirmed.)
2. **One shared Dockyard AWS account, or per-user AWS credentials?** This drives whether zone
   discovery and record management are global or scoped per user.
3. **Multi-tenancy:** who may claim a subdomain of a shared hosted zone — any authenticated
   user, or only an admin/owner? What prevents one tenant from hijacking another's subdomain?
4. **Region and default TTL** — confirm `AWS_REGION` and the record TTL.
5. **Edge host** — is `dockyard-ai.com` the correct CNAME target in production, and is there a
   staging edge host to parameterize via `DOCKYARD_EDGE_HOST`?

## Follow-ups (explicitly deferred)

- Apex-domain support (`A`/`ALIAS` + stable edge IP).
- Non-Route-53 providers.
- ACM certificate + CloudFront distribution path.
- Cross-account role assumption for zones in other AWS accounts.
