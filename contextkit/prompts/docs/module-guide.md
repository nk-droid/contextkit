Generate `MODULE_GUIDE.md` for the target repository.

Audience:
A developer who wants a practical map of important files and directories.

Required structure:

# Module Guide

## Repository map
Give a concise tree-style map of the important directories. Do not include dependency folders or generated files.

## Important directories
For each important directory:
- path
- purpose
- key files
- how it fits into the project

## Important files
List important files that a new reader should inspect, with reasons.

## Entry points
Identify application, package, CLI, worker, frontend, test, or script entry points.

## Configuration files
Explain config files such as package files, pyproject, Docker files, CI, env examples, tsconfig, vite config, etc.

## Test files
Explain where tests live and what they likely cover.

## Generated or low-priority files
Mention files/directories that can be ignored initially.

## Suggested reading paths
Provide reading paths for:
- quick overview
- debugging
- adding a feature
- reviewing a PR
