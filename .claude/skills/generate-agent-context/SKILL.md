---
name: generate-agent-context
description: Generate concise structured context for AI agents working with a repository.
---

Use this skill when the output will be consumed by an AI coding assistant, code review agent, or automation.

Steps:
1. Identify repository purpose.
2. Identify hard rules an agent should follow.
3. List important paths and entry points.
4. List commands for setup, test, lint, build, and run when discoverable.
5. Summarize architecture compactly.
6. Provide change guidance and review guidance.
7. List uncertainties.

Output:
- A markdown document following `contextkit/templates/AGENT_CONTEXT.md`.
- Be concise and unambiguous.
