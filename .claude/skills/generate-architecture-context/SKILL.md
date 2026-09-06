---
name: generate-architecture-context
description: Generate architecture context for a repository using ContextKit standards.
---

Use this skill when the user wants system design, module boundaries, or architecture context.

Steps:
1. Inspect README, config files, source directories, tests, and deployment files.
2. Identify major modules and their responsibilities.
3. Identify entry points and important runtime flows.
4. Summarize state, data, configuration, and external dependencies.
5. Describe testing and validation structure.
6. Add trade-offs and unknowns, clearly marked as inferred where needed.

Output:
- A markdown document following `contextkit/templates/ARCHITECTURE.md`.
- Keep explanations grounded in file paths.
