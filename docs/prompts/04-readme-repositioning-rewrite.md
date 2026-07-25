# Prompt: README / Repositioning Rewrite for Dockyard

## Purpose

Rewrite Dockyard's README to sharpen the project's positioning, communicate its value more precisely to a target audience, and give operators and potential contributors what they actually need — without losing the honest, direct tone the current README has.

## Why this matters for Dockyard specifically

The current README is comprehensive and honest, but it reads like a feature inventory rather than a positioned product document. Anyone landing on the repository for the first time faces several questions the README doesn't answer clearly:

- **Who is this for?** (Solo operator? Small team? Self-hoster?)
- **What makes this different** from Portainer, Yacht, or Dozzle?
- **Is it safe to use?** (It manages Docker, databases, DNS, and runs AI-generated code — that warrants a trust model section)
- **How do I get started quickly?** (Setup steps exist but aren't front-loaded)
- **What's experimental vs. stable?**

The README also undersells the project's most distinctive capability — the AI-assisted issue-to-fix pipeline — by burying it in a feature list rather than positioning it as a core differentiator.

## Embedded project context

### What Dockyard actually is

A **personal Docker IaaS control plane** for operators who manage their own infrastructure. It provides:

- **Instances** — EC2-style container launch presets across web, database, cache, runtime, and OS categories
- **Disk awareness** — host disk reporting live in the UI before any launch
- **Buckets** — self-managed MinIO with S3-compatible object storage
- **Gateway** — named routes that proxy to containers, buckets, or lambda functions
- **Lambda functions** — on-demand execution via the gateway
- **Database admin** — MySQL and MongoDB management with encrypted credentials, schema inspection, and mutation previews
- **Notifications** — real-time event and alert system
- **Assistant** — Anthropic/DeepSeek-powered chat with operator context
- **Issue pipeline** — automated issue-to-fix-to-deploy loop with AI code generation

### What makes Dockyard unusual

1. **Disk awareness is a first-class feature**, not an afterthought — disk impact is shown before every container launch
2. **The assistant is integrated into the operator workflow**, not bolted on as a chatbot
3. **The issue-to-fix pipeline is real** — not a demo; it actually commits and deploys fixes
4. **Everything is self-hosted and self-managed** — no third-party SaaS dependencies in the data path

### Target audience options to choose from (pick the most accurate one or combine)

- Solo operators managing personal or homelab infrastructure
- Developers who want a self-hosted ops console without Kubernetes complexity
- Engineers building AI-native internal tooling

### Honest caveats that belong in the README

- Requires Docker socket access — this is a high-privilege application
- Not designed for public exposure without auth in front of it (Caddy handles TLS)
- The autonomous fix pipeline should be treated as a power feature, not a default
- Multi-user support is present but the trust model is still maturing

### Tech stack (for a badge / stack section)

- Node.js + Express + TypeScript (server)
- React + Vite + TypeScript (web)
- SQLite (via better-sqlite3)
- Docker (via dockerode)
- MinIO (self-provisioned)
- Caddy (reverse proxy + TLS)
- GitHub Actions + GHCR (CI/CD)
- Anthropic / DeepSeek (assistant)

## Instructions

Rewrite the Dockyard README using the context above. The rewrite must:

### 1. Open with a sharp one-liner and a clear value proposition
- Not a feature list — a single sentence that explains what Dockyard is and who it's for
- Follow with 3–5 sentences that expand the "why" before listing any features

### 2. Include a "What makes it different" section
- Compare to the obvious alternatives (Portainer, Yacht, Dozzle, raw `docker ps`)
- Be honest about what Dockyard does better and where it trades simplicity for power

### 3. Retain the feature list but structure it better
- Group features into coherent capability areas (Infrastructure, Storage, Data, Intelligence, Ops)
- Call out which features are experimental or power-user-facing

### 4. Add a "Trust model / Security posture" section
- Be transparent about what privileges Dockyard requires and why
- Explain what it accesses: Docker socket, host filesystem, saved credentials, GitHub token
- State recommended deployment posture (e.g., "run behind Caddy with auth, on a trusted network only")
- This section increases trust, not decreases it — operators appreciate transparency

### 5. Front-load the quickstart
- Prerequisites (Docker, Node.js version, etc.)
- Clone → configure → `docker compose up` steps
- First thing to do after startup

### 6. Add a "Stability" or "Status" section
- What is considered stable
- What is experimental (e.g., autonomous fix pipeline, DNS automation)
- What is personal/opinionated and may not fit every setup

### 7. Keep the tone
- Practical and direct — no marketing fluff
- Honest about limitations
- Written by and for operators, not a product landing page

### 8. Optional: add a screenshot or architecture diagram placeholder
- Even a placeholder block encourages future contributors to fill it in

## Expected output / acceptance criteria

- A complete Markdown README, ready to replace the existing one
- Opens with a sharp, jargon-free value proposition — not a feature dump
- "What makes it different" section exists and is specific (not "it's better than alternatives")
- Trust model / security section exists and is honest
- Quickstart is near the top (within first 40% of the document)
- Feature list is organized into logical groups, not a flat bullet dump
- Tone is practical and operator-focused throughout
- No marketing fluff, no generic open-source boilerplate

## Optional: files to include for richer output

Attach or paste the following for the most accurate rewrite:

- Current `README.md` — to preserve accurate details and avoid inventing facts
- `docker-compose.yml` — to confirm the actual quickstart steps
- `server/src/index.ts` — to understand what the server actually exposes
- Any screenshots or demo GIFs — to write accurate alt text and captions
