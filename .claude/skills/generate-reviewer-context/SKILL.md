---
name: generate-reviewer-context
description: Generate PR reviewer guidance for a repository.
---

Use this skill when the user wants to review changes in an unfamiliar repository.

Steps:
1. Identify high-risk areas from source layout, tests, config, and runtime files.
2. Identify common change types.
3. Identify validation commands.
4. List files that should be reviewed together.
5. Create a review checklist.
6. Add concrete questions to ask before approving a PR.
7. Separate strong evidence from inference.

Output:
- A markdown document following `contextkit/templates/REVIEWER_GUIDE.md`.
