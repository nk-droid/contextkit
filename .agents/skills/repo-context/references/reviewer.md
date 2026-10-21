Generate `REVIEWER_GUIDE.md` for the target repository.

Audience:
Someone reviewing a pull request in this repo.

Required structure:

# Reviewer Guide

## Review mindset
Explain how to review changes in this repo.

## High-risk areas
List paths or modules where changes deserve extra attention. Explain why.

## Common change types
Identify likely change categories such as API changes, UI changes, data model changes, config changes, test changes, docs changes, or infra changes.

## Review checklist
Provide a practical checklist:
- correctness
- tests
- edge cases
- security
- performance
- backwards compatibility
- docs
- operations

## Validation commands
List commands to run if discoverable. If not discoverable, say what is missing.

## Files to inspect together
Mention files that should usually be reviewed together because they are coupled.

## Questions to ask before approving
Give concrete review questions.

## Red flags
List signs that a PR may be risky in this repo.

## Confidence notes
Separate strong evidence from inferred guidance.
