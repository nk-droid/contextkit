Generate `AGENT_CONTEXT.md` for the target repository.

Audience:
An AI coding/review agent that needs concise, reliable context before answering questions or suggesting changes.

Required structure:

# Agent Context

## Repository purpose
Briefly state what the repository does.

## Hard rules for agents
List rules an AI agent should follow when working with this repo.

## Important paths
List important paths with short explanations.

## Entry points
List runtime, CLI, API, worker, frontend, package, or test entry points.

## Commands
List setup, test, lint, build, and run commands if discoverable.

## Architecture summary
Give a compact architecture summary.

## Change guidance
For common change types, explain what files to inspect and what to validate.

## Review guidance
Give a concise review checklist.

## Uncertainty
List unknowns or assumptions that an agent should not overstate.

## Response style
Describe how an agent should answer questions about this repo.
