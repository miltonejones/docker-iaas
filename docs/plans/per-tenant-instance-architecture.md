# Architecture direction: per-tenant Dockyard instances (multi-user)

> **Status: far-future / directional.** Not scheduled work. This is the intended path for taking
> Dockyard multi-user, captured so the reasoning isn't lost. Nothing here is needed while Dockyard
> is single-operator. Treat it as an architecture decision record + build outline, not a task list.

## The core idea

When a new user is created, Dockyard provisions that user their **own dedicated Dockyard
instance** — their own container (properly isolated — see below) or their own VM/EC2 — rather than
serving many tenants from one shared Dockyard.

## Why this shape (and not multi-tenancy inside the app)

Dockyard is already a clean **single-tenant** application: it assumes one trusted operator who owns
the Docker daemon, the host, and the credentials. That assumption is *why the app is simple and why
its broad trust surface is acceptable today.* Rather than rewrite the app to be internally
multi-tenant (per-user workspaces, per-tool authorization, an ownership-aware Docker broker, DNS
namespace enforcement — a large, error-prone refactor), keep the app single-tenant and move
isolation **up to the instance boundary**: one Dockyard per user. Each instance is "single trusted
operator" again — the model that already works.

### What per-tenant isolation dissolves
Every top trust-surface concern becomes a *within-one-tenant* concern the user already owns:
- **Docker socket** → Alice's Dockyard controls Alice's own daemon on Alice's own box.
- **`/host` mount** → it's Alice's host; only Alice's files.
- **AWS / Route 53 / GitHub / LLM keys** → Alice's instance holds Alice's own credentials.
- **Prompt injection** (assistant/consumer on untrusted issue text) → blast radius is bounded to
  Alice's own instance, which she consented to.

Isolation lands at the OS/VM boundary — the strongest available — instead of a policy check an LLM
might be talked into evading.

## Decision 1 — the isolation unit (with the critical gotcha)

Each user's Dockyard must manage Docker (that's the product). Therefore **each tenant needs its own
Docker daemon.** This is the make-or-break detail:

| Option | Isolation | Notes |
|---|---|---|
| **Plain container on a shared host sharing `/var/run/docker.sock`** | ❌ **None** | Alice's container gets the *host* daemon → she can see/control Bob's containers and the host. **This re-creates the exact problem with a false sense of security. Do not do this.** |
| **sysbox-runc container per user** | ✅ Good | Each container runs a real, isolated *inner* Docker daemon, unprivileged. Dense and cheap. Good "density tier." |
| **Docker-in-Docker (privileged)** | ⚠️ Weak | Privileged DinD is itself a host-escape risk. Avoid. |
| **VM / EC2 per user** | ✅✅ Strong | Own kernel + daemon + everything; hypervisor-grade isolation. Truly dissolves the concerns. Higher cost, slower provision (~minutes). |
| **microVM (Firecracker) per user** | ✅✅ Strong | VM-grade isolation with much faster boot / higher density than EC2. Best long-term target if self-managing the substrate. |

**Recommendation:** microVM/EC2 per user for the security tier; sysbox for a cheaper density tier
later. **Never** plain containers sharing the host socket — that is the one design that looks like
isolation but provides none.

## Decision 2 — the control plane (the new crown jewel)

Something must provision an instance per signup, inject that user's credentials, wire routing, and
manage lifecycle. **This orchestrator becomes the highest-value target** — it holds credentials that
can *create VMs/EC2 and Docker daemons*, which is far more powerful than any per-user key. The trust
surface didn't vanish; it moved up a level and shrank to a small, well-defined component you can
harden hard.

Control-plane responsibilities:
- **Provision / deprovision**: create the tenant's instance (VM or sysbox container), from a pinned
  Dockyard image/version; tear it down on account deletion.
- **Credential injection**: place the tenant's own creds into their instance (e.g. as instance-local
  secrets), so the control plane ideally *transits* but does not *retain* user secrets.
- **Lifecycle**: start / stop / hibernate (idle instances cost money), health, restart.
- **Inventory**: tenant → instance mapping, ownership, status.

Hardening the control plane is the whole game once multi-user: least-privilege cloud role scoped to
exactly the provisioning actions; no LLM/agent anywhere near it; strong auth; full audit; and it
must never be reachable from tenant instances (one-way control).

## Decision 3 — the shared edge / router

A shared front door at e.g. `dockyard.app` authenticates the user and routes them to **their**
instance, and points custom domains at the right tenant instance. This is the only other shared
component. Design points:
- Tenant → instance routing (reverse proxy / SNI routing keyed on the authenticated user or
  hostname).
- Custom-domain provisioning now maps a domain to a *specific tenant instance*, not to one app —
  the per-tenant analogue of today's Caddy work.
- Keep the edge dumb and stateless; auth + routing only; no tenant data.

Control plane + edge are the **only** shared surfaces. Everything else is per-tenant and isolated.

## Lifecycle, cost, and fleet operations (the real ongoing cost)

Per-tenant instances trade an app refactor for platform operations:
- **Cost/density**: an idle VM per user is money → stop/hibernate-when-idle; start on access; or run
  the density (sysbox) tier for light users and graduate heavy users to dedicated VMs.
- **Provisioning latency**: VMs take minutes → pre-warm a pool, or use microVMs for fast boot.
- **Fleet updates**: there are now *N* running copies of Dockyard. Shipping an update means a rolling
  fleet upgrade (versioned images, controlled rollout, per-tenant migration of the SQLite schema),
  not one deploy. This is the biggest operational shift — design the update mechanism early.
- **Backup / DR** per tenant; **orphan cleanup**; **metering / billing** hooks.

## Relationship to the other plans

- **`per-user-credentials.md`** largely *collapses* under this model: each instance simply holds its
  own credentials (like today's single operator), so the encrypted multi-user credential store is
  no longer required inside the app. What remains is the control plane injecting each tenant's creds
  into their instance at provision time. (Per-user credentials is still worth doing first as a
  single-operator improvement — it just doesn't need to grow into multi-user.)
- **`security-and-caddy-hardening.md`** still applies **per instance** — each tenant's Dockyard
  wants the same hardening. The custom-domain/Caddy design becomes per-tenant, fronted by the shared
  edge router.
- The **multi-tenant-inside-one-app** approach (per-user workspaces, Docker broker, DNS namespace
  enforcement) is **superseded** by this — it was the alternative if per-tenant instances proved too
  costly. Keep it in the back pocket only as a density fallback.

## Suggested staging (if/when this is pursued)

1. **Today:** single operator; do `per-user-credentials` + finish `security-and-caddy-hardening`.
2. **First multi-user step:** control plane + shared edge, provisioning **VM/EC2 per user** (simplest
   correct isolation), manual-ish lifecycle. Small number of users.
3. **Density:** introduce a **sysbox** tier for light users; hibernate-when-idle; a real fleet-update
   pipeline.
4. **Scale:** microVMs, pooling/pre-warm, automated metering/billing/DR.

## Open questions

- **Self-managed substrate vs. managed?** microVMs/sysbox imply running your own host fleet; EC2-per-
  user leans on AWS. Which substrate?
- **Does the control plane retain tenant secrets, or only transit them?** Prefer transit-only
  (inject at provision, never store) to keep the crown jewel from also being a secret vault.
- **Update/migration contract:** how do per-tenant SQLite schemas migrate on a fleet upgrade, and
  what's the rollback story?
- **Cost model / SKU tiers:** dedicated-VM tier vs. shared-host sysbox tier — pricing and placement.

## Explicitly out of scope (for now)

Everything here. This is the destination, not a current task. The single-operator hardening work is
the only thing that should be built until a real second user is on the horizon.
