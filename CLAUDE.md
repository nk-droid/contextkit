# ContextKit Project Instructions

ContextKit is a local-first repository understanding kit. It generates readable context packs for public GitHub repos and locally cloned private repos without copying ContextKit into the target repository.

## Product Rules

- Keep ContextKit separate from the target repo.
- Do not require users to commit ContextKit files into repositories they analyze.
- Default behavior must be read-only for target repositories.
- Generated output should go into `context-packs/<repo-name>/` or a user-provided output directory.
- Prefer human-friendly explanation over raw file dumps.
- Every generated claim should be grounded in visible repository files or clearly marked as an inference.

## Tone

Write like a senior engineer onboarding another engineer:

- clear
- practical
- direct
- no hype
- no vague claims
- no exaggerated architecture assumptions

## Development Rules

- Keep the MVP small.
- Avoid adding heavy dependencies.
- Prefer Bash and Markdown unless a real CLI framework becomes necessary.
- If adding code, include usage examples and failure modes.
- Never suggest writing into the target repo by default.

## Key Commands

```bash
bin/contextkit generate https://github.com/owner/repo --audience human
bin/contextkit generate ~/work/private-repo --all
bin/contextkit generate ~/work/private-repo --all --with-graph
bin/contextkit generate ~/work/private-repo --audience reviewer --output ./context-packs/private-repo
make web-dev
```

## Context Document Standards

Generated documents should include:

- what the project does
- why it exists
- main components
- important flows
- what to read first
- how to run/test when discoverable
- uncertainty notes when something is not clear
