# Prompt: Security Review Checklist for Dockyard

## Purpose

Produce a structured, pass/fail security review checklist tailored to Dockyard's specific privilege model and attack surface. The output should be usable as a recurring audit document — not a generic OWASP checklist, but a checklist grounded in what Dockyard actually does.

## Why this matters for Dockyard specifically

Dockyard is not a typical web application. It is effectively a **root-adjacent operator console** that can:

- Control the Docker daemon via `/var/run/docker.sock`
- Read the host filesystem (`/:/host:ro` Compose mount)
- Store and decrypt database credentials (MySQL, MongoDB)
- Push commits and trigger deployments via GitHub token
- Automate DNS changes
- Execute AI-generated code and apply it to the running system
- Invoke user-defined lambda functions and proxy external traffic

A vulnerability in Dockyard does not mean a leaked email address. It means potential host compromise, credential theft, or unauthorized deployment. The security review must be calibrated to that risk level.

## Embedded project context

- **Auth:** Authentication is present; role-based access control and capability boundaries are underdeveloped relative to privilege level
- **Secrets in scope:** Anthropic/DeepSeek API key, GitHub token, DB master encryption key, DNS credentials, consumer JWT secret, DB connection credentials — all within one trust domain
- **Crypto:** Database credentials encrypted with AES-256-GCM (`server/src/databaseManagement.ts`)
- **Dangerous routes exist for:** container exec, host file copy, DB mutations, GitHub push, deploy trigger, gateway proxying, lambda invocation
- **Automation pipeline:** `scripts/issue-consumer.mjs` can take an issue, generate code changes, commit, push, and deploy — currently without a mandatory PR review gate
- **Gateway:** Named routes proxy to containers, buckets, or lambdas; request forwarding introduces SSRF-adjacent risks
- **Sessions:** SQLite-backed persistent assistant sessions; session data may contain sensitive context
- **Deployment:** SSH-based deploy triggered from GitHub Actions with secrets mounted via Docker secrets

## Instructions

You are performing a structured security review of Dockyard. Produce a checklist organized into the categories below. For each item:

- State the check as a pass/fail question (e.g., "Are all destructive routes protected by auth middleware?")
- Mark current status as: ✅ Pass | ❌ Fail | ⚠️ Partial | ❓ Unknown (requires code inspection)
- Add a one-sentence note explaining the consequence of failure or what to verify
- Flag items that are **Critical** (compromise or data loss risk) vs. **High** / **Medium** / **Low**

### Checklist categories to cover

#### 1. Authentication and session management
- Route-level auth enforcement (all privileged routes require valid session)
- Session token strength, expiry, and rotation
- CSRF protection for state-changing requests
- Secure cookie flags (`HttpOnly`, `Secure`, `SameSite`)
- Brute-force / rate-limit on login endpoints
- Multi-session / concurrent session handling

#### 2. Authorization and access control
- Role or capability checks beyond simple authentication
- Ownership enforcement: can user A access user B's containers / buckets / DB connections?
- Privilege escalation paths (any route that allows self-promotion)
- Step-up confirmation for destructive actions (container remove, DB drop, host file copy)
- Admin-only route separation

#### 3. Secret and credential management
- No secrets committed to the repository
- AES-256-GCM key storage and rotation strategy
- GitHub token scope (is it narrowed to minimum required?)
- DNS credential isolation
- Consumer JWT secret strength and rotation
- Secret exposure in logs, error messages, or API responses

#### 4. Host and Docker access
- Docker socket exposure scope — who/what can reach it
- Host filesystem mount policy — is path traversal or sensitive file access possible?
- Container exec validation — input sanitization, allowlisting, timeout enforcement
- Image pull from untrusted sources — is there any validation?
- Container privilege level — are containers launched with excessive capabilities?

#### 5. Autonomous code modification and deployment pipeline
- PR-first gate — is direct push/deploy blocked by default?
- File policy enforcement — are protected files actually protected from AI changes?
- Token permissions for the consumer — is the GitHub token scoped to minimum required?
- Approval gate — does any human review occur before deploy-affecting changes land?
- Rollback strategy — can a bad automated deploy be reverted quickly?
- Change provenance — are AI-authored commits clearly labeled?

#### 6. Gateway and lambda attack surface
- SSRF risk — can a gateway route be configured to reach internal services or metadata endpoints?
- Request header forwarding — are sensitive headers (auth, cookies) stripped before proxying?
- Lambda input validation — is user-provided input sanitized before invocation?
- Gateway route ownership — can one user add a route that shadows another user's traffic?
- Response content-type enforcement — can a gateway response inject scripts into the UI?

#### 7. Database administration surface
- Query preview/confirm invariant — is it enforced server-side, not just client-side?
- SQL injection risk in dynamic query construction
- MongoDB injection risk in dynamic filter construction
- Backup file access — are backup files stored at predictable paths or served unprotected?
- Connection credential isolation — can user A use user B's saved DB connection?

#### 8. Audit and observability
- Audit log exists for: container create/remove, DB mutations, GitHub push, deploy, host file copy, gateway route changes
- Audit log is append-only and tamper-resistant
- Failed auth attempts are logged
- Sensitive input (passwords, tokens) is redacted from logs
- Audit log is accessible to admin without requiring direct DB access

#### 9. Infrastructure and deployment
- Docker secrets used for all sensitive values (not plain env vars in Compose)
- TLS enforced by Caddy — no plain HTTP paths reachable
- SSH key scope for deploy — is it narrowed to deploy-only?
- GHCR image signing or digest pinning
- Dependency supply-chain — are `npm audit` results reviewed?
- Compose file does not expose unnecessary ports to the host

#### 10. Input validation and injection
- All user inputs validated server-side (not just client-side)
- File upload: size limit enforced, content-type validated, stored safely
- Path traversal: user-supplied file paths are sanitized
- Command injection: no shell execution with unsanitized user input
- Object prototype pollution risk in any `merge`/`assign` paths

## Expected output / acceptance criteria

- A Markdown document with all 10 sections, each with 5–8 checklist items
- Each item has: check question, status (Pass/Fail/Partial/Unknown), consequence note, and severity label
- Critical items are summarized at the top as a **"Fix immediately" list**
- The review is specific to Dockyard — not copy-pasted OWASP boilerplate
- A reviewer could use this doc quarterly to track security posture over time

## Optional: files to include for richer output

Attach or paste the following for the most accurate assessment:

- `server/src/routes/` — all route files, to check auth middleware coverage
- `server/src/databaseManagement.ts` — crypto and query-building logic
- `server/src/gatewayProxy.ts` — proxy and SSRF risk
- `scripts/issue-consumer.mjs` — autonomous pipeline governance
- `docker-compose.yml` — secret and port exposure
- `.github/workflows/` — CI/CD token and secret usage
