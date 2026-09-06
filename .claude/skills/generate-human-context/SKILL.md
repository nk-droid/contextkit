---
name: generate-human-context
description: Generate a human-friendly repository overview using ContextKit standards.
---

Use this skill when the user asks for a readable overview of a repository.

Steps:
1. Inspect README and top-level project files.
2. Identify language, framework, package manager, and entry points.
3. Inspect major source directories and tests.
4. Write a plain-English explanation of what the repo does.
5. Explain main components and how the system works.
6. Include a practical "what to read first" section.
7. Mark unclear or inferred claims.

Output:
- A markdown document following `contextkit/templates/HUMAN_OVERVIEW.md`.
- Use file paths as evidence.
- Do not wrap output in code fences unless the user explicitly asks.
