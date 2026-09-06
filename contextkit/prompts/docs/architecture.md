Generate `ARCHITECTURE.md` for the target repository.

Audience:
A senior engineer or maintainer trying to understand system design and technical boundaries.

Required structure:

# Architecture

## System purpose
Explain the project purpose based on repository evidence.

## Architecture at a glance
Describe the main architecture in 5-8 bullets.

## Major modules and boundaries
For each major module:
- path
- responsibility
- what it depends on
- what depends on it, if visible

## Important flows
Describe key flows such as request flow, data flow, job flow, build flow, CLI flow, or model/evaluation flow depending on the repo.

## Data and state
Explain where data/state/configuration appears to live.

## External dependencies
List important external systems, services, libraries, APIs, databases, queues, or frameworks.

## Testing and validation architecture
Explain how tests, linting, CI, or validation are organized.

## Operational notes
Mention Docker, deployment, environment variables, scripts, observability, or runtime concerns if present.

## Design trade-offs
Infer likely trade-offs, but label them as inferred.

## Architecture risks or unknowns
Mention areas that need verification.
