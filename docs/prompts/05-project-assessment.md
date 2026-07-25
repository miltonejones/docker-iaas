# Prompt: Investor- / Hiring-Manager-Style Project Assessment for Dockyard

## Purpose

Produce a candid, structured assessment of the Dockyard project written from the perspective of a technical investor or a senior engineering hiring manager evaluating it as a portfolio piece. The output should read like feedback you'd get from a technical due-diligence partner or a principal engineer reviewing a take-home — honest, specific, and calibrated to what the project actually demonstrates.

## Why this matters for Dockyard specifically

Dockyard is an ambitious personal project with real engineering depth. It's also complex enough that the usual "impressive breadth" shorthand doesn't capture what's actually worth highlighting — or what raises questions. A generic "this is a good project" summary would undersell the strengths and gloss over the maturity gaps that a sophisticated evaluator would immediately notice.

This prompt is specifically designed to produce an assessment that:

- Gives credit where it's genuinely due (and this project earns real credit)
- Surfaces concerns that a technical due-diligence partner or principal engineer would raise
- Frames both in a way that's useful for a conversation, not just a grade

## Embedded project context

### What the project is

**Dockyard** is a personal Docker IaaS control plane — a self-hosted, full-stack web application that manages Docker containers in an EC2-style interface, with tight host disk awareness, self-managed MinIO object storage, gateway routing, lambda-like functions, MySQL/MongoDB database administration, a real-time notification system, an AI assistant integrated into the operator workflow, and an autonomous issue-to-fix-to-deploy pipeline.

### Scope summary

| Domain | What it does |
|---|---|
| Container management | Launch presets (EC2-style AMIs), start/stop/remove, log streaming, live state |
| Disk management | Host disk gauge, Docker footprint breakdown, reclaim space (prune) |
| Object storage | Self-managed MinIO: buckets, object browse/upload/download/delete |
| Gateway | Named routes proxying to containers, buckets, or lambda functions |
| Lambda functions | On-demand execution via gateway; user-defined |
| Database admin | MySQL + MongoDB: encrypted credentials, schema inspection, mutation previews, backup/restore |
| Notifications | Real-time event system with SSE-based live delivery |
| Assistant | Persistent AI sessions (Anthropic/DeepSeek) with operator context |
| Issue pipeline | Issue → AI-generated fix → commit → deploy, automated end-to-end |
| Relay | Remote node connection model for multi-host use |

### Stack

- **Server:** Node.js, Express, TypeScript, better-sqlite3, dockerode
- **Web:** React, Vite, TypeScript
- **Infra:** Docker, MinIO, Caddy (TLS), GitHub Actions, GHCR
- **AI:** Anthropic / DeepSeek APIs
- **Deployment:** SSH-based deploy from CI, ARM image builds

### Honest known weaknesses (from prior evaluation)

1. **Security posture lags privilege level** — the app holds Docker socket, host FS, DB credentials, GitHub token, DNS credentials, AI API keys; auth/authz maturity is not yet proportional to that trust
2. **Architecture is getting monolithic** — `server/src/db.ts`, `server/src/databaseManagement.ts`, `web/src/api.ts`, and `scripts/issue-consumer.mjs` (~56 kB) are oversized and mixed-responsibility
3. **Autonomous pipeline needs stronger governance** — the issue-to-fix pipeline does direct push/deploy by default; no mandatory PR review gate
4. **Test confidence likely below risk level** — tests exist, but integration/authz coverage for high-privilege paths is unclear
5. **Product scope is unusually broad** — it is simultaneously a container IaaS, DB admin, object store, gateway, AI ops console, and autonomous devops agent

## Instructions

Write a candid, structured project assessment of Dockyard. The assessment should be written as if authored by a **senior principal engineer or technical investor** who has read the README, reviewed the codebase structure, and is giving feedback to the author directly.

### Tone and framing

- Peer-to-peer, direct — not a performance review or job interview feedback
- Credit is specific ("this is good because X, which is rare at this stage")
- Concerns are specific ("this is a risk because Y, and the consequence is Z")
- Avoid both pure praise and pure criticism — the goal is calibrated judgment
- End with a clear overall take and what you'd advise the author to do next

### Required sections

#### 1. What this project demonstrates (strengths)
Cover at least:
- Product vision and concept clarity
- Implementation breadth and depth (what's actually working, not just wired up)
- Engineering discipline signals (CI/CD, TypeScript, Dockerized deploy, etc.)
- Operator-centric design thinking
- Ambition-to-execution ratio

Be specific — reference actual capabilities, not generic phrases like "great full-stack project."

#### 2. What raises questions (concerns)
Cover at least:
- Security posture relative to privilege level (this is the most important concern)
- Architectural risk from oversized modules and single-app privilege concentration
- Automation governance (autonomous fix pipeline without mandatory review gate)
- Test confidence for high-blast-radius paths
- Solo-maintainer sustainability at current scope
- Product scope clarity — what is the core product?

Be direct without being dismissive. These are serious concerns, not nitpicks.

#### 3. What it says about the author
Infer what the project signals about the author's:
- Engineering taste and judgment
- Comfort zone (what they clearly know well)
- Blind spots (what the project suggests they are still developing)
- Ambition and shipping energy
- Self-awareness (does the README acknowledge limitations honestly?)

This section is the most human — be genuinely thoughtful, not formulaic.

#### 4. Comparison to peers
Compare this project to the typical portfolio project in its class:
- What does Dockyard have that most projects don't?
- What does Dockyard lack that a hardened production system would have?
- Where does it sit on the spectrum from "impressive demo" to "production-ready platform"?

#### 5. Overall verdict and recommendation
- A one-sentence overall assessment
- A 3-item "do this next" list that the author should prioritize
- An honest answer to: "Would you want this person on your team? What role?"

### Scoring (optional but recommended)
Score each dimension from 1–10 with a one-sentence rationale:
- Product vision
- Execution breadth
- Codebase maintainability
- Security posture
- Operational maturity
- Portfolio / hiring-manager signal

## Expected output / acceptance criteria

- 1,000–2,000 words
- Each section is present and substantive (not one-liners)
- Strengths are specific and not generic ("great full-stack project" is not acceptable)
- Concerns are calibrated to the actual risk level — security concerns are proportionally weighted
- The "what it says about the author" section is thoughtful and non-formulaic
- The overall verdict is decisive — not "it depends"
- A hiring manager could use this document to prepare interview questions
- A technical investor could use this as a due-diligence summary

## Optional: files to include for richer output

Attach or paste any of the following to ground the assessment in code evidence:

- `README.md` — for product positioning signal
- `server/src/db.ts` — for architecture signal
- `server/src/databaseManagement.ts` — for security/complexity signal
- `.github/workflows/` — for CI/CD maturity signal
- `docker-compose.yml` — for operational maturity signal
- `scripts/issue-consumer.mjs` — for automation governance signal
- Any test files — for test confidence signal
