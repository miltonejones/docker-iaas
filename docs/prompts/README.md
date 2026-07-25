# Dockyard Prompt Library

This directory contains focused, actionable prompts derived from a structured evaluation of the **Dockyard** repository — a high-privilege personal Docker IaaS control plane with container management, object storage (MinIO), gateway routing, lambda-like functions, database administration, notifications, an AI assistant, and an autonomous issue-to-fix pipeline.

Each file is a standalone prompt that an AI assistant or human collaborator can use to produce a specific artifact. They contain enough embedded context to be used independently, without needing to re-read the codebase first.

---

## Prompt files

| File | Artifact | When to use |
|---|---|---|
| [01-prioritized-issue-list.md](./01-prioritized-issue-list.md) | Ranked backlog of the most important open problems | Before planning a sprint or deciding what to work on next |
| [02-security-review-checklist.md](./02-security-review-checklist.md) | Structured security review with pass/fail criteria | Before any public exposure, new privileged feature, or external audit |
| [03-refactor-plan-by-file.md](./03-refactor-plan-by-file.md) | File-by-file decomposition and refactor roadmap | Before adding significant new features; when a file is becoming a bottleneck |
| [04-readme-repositioning-rewrite.md](./04-readme-repositioning-rewrite.md) | Rewritten README with sharper positioning | When preparing to share the project publicly, seek contributors, or pitch it |
| [05-project-assessment.md](./05-project-assessment.md) | Investor- or hiring-manager-style project assessment | When applying for roles, seeking feedback, or pitching the project |

---

## How to use these prompts

1. Open the relevant file.
2. Copy the full contents.
3. Paste into your AI assistant (Claude, Copilot Chat, ChatGPT, etc.) or share with a collaborator.
4. Optionally append any file excerpts, recent diffs, or additional context the prompt requests.
5. Review the output against the **Expected output / acceptance criteria** section before using it.

Each prompt is intentionally opinionated about the Dockyard project specifically — not a generic template.
