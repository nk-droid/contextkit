---
name: generate-all-context
description: Generate a complete ContextKit context pack for a repository.
---

Use this skill when the user asks to generate a full context pack.

Generate these documents:

1. `HUMAN_OVERVIEW.md`
2. `ARCHITECTURE.md`
3. `MODULE_GUIDE.md`
4. `REVIEWER_GUIDE.md`
5. `CONTRIBUTOR_GUIDE.md`
6. `AGENT_CONTEXT.md`
7. `INTERVIEWER_BRIEF.md`

Rules:
- Keep every document grounded in repository evidence.
- Mention file paths.
- Mark uncertain claims.
- Do not modify the target repository unless the user explicitly requests where to write output.
- Prefer clear human explanations over exhaustive raw listings.
