# Slice 2: behavior and data

The foundation slice established *what* the parts are. This slice establishes *how they
behave* and *what they do with data*.

The component and external-system ids in the briefing are frozen. Reference them; do not
rename them, and do not invent a sibling because a name reads slightly wrong. If a
component is genuinely missing, record an unknown — a later pass can fix the registry, and
a silently invented id cannot be traced to anything.

## Produce

**relationships** — what depends on what. `sourceId` is always a component in this
repository; `targetId` may be another component, an external system, or a store declared
in this result, because "the
gateway depends on the LLM provider" is a relationship worth recording like any other.

`direction`, `synchronous` and `optional` describe the call, not your confidence in it.
`dataExchanged` says what actually crosses; `failureBehavior` says what happens when the
target is unavailable — if the code does not handle that, say so plainly rather than
describing what it ought to do.

Every relationship must trace to a call edge, an import, or a route. "These two probably
talk" is not a relationship; it is an unknown.

**runtimeFlows** — the paths a request or event actually takes, in order. A flow is what
you would trace with a debugger: `trigger` starts it, `steps` name the component doing
each piece, `outcome` is what it leaves behind. `actorIds` are the components involved.

`alternatePaths` and `failureModes` are where the value is — the retry, the dead letter,
the early return. A flow with only the happy path describes a demo, not a system. Leave
them empty only if you genuinely found none.

Prefer three or four flows a maintainer would recognize over a dozen mechanical ones.

**boundaries** — where trust, process, or network changes. `insideEntityIds` and
`outsideEntityIds` say what sits on each side; `contract` says what must hold for a
crossing to be safe; `risks` says what happens when it does not. A webhook handler
receiving unauthenticated input is a trust boundary; a call between two modules in the
same process is not.

**invariants** — things that must stay true for the system to work. Only ones the code
enforces or clearly assumes.

**apiSurfaces** — the surfaces other systems or people use. The scanner owns method and
path; you supply `stability`, `consumerEntityIds`, and what the endpoints mean.

For anything auth-related, write what the code *requires*. If you did not see an
authentication check, say "not established from the available facts" — not "none", which
asserts something you did not observe. One is a gap in the analysis, the other is a
security claim.

**dataContracts** — schemas crossing a boundary. `producerEntityIds` and
`consumerEntityIds` matter more than the shape itself, which the scanner already has.

**stores / entities** — what persists, where, and who owns it. `durability`,
`sensitiveData`, and `keyFields` are the fields a reader actually needs.
`definitionPaths` must exist in the inventory.

Give semantic projections their own IDs, distinct from scanner detection IDs. If a
detection ID is reused for its matching semantic record kind, the pipeline assigns a
separate stable semantic ID and updates references; the original response is retained.

**retentionRules / consistencyRules** — grounded statements about how long data lives and
what guarantees hold. Leave empty rather than inventing a policy the code does not show.

**annotations** — assign the symbols that matter to their components, and summarize the
declarations someone must read first.

## Method

1. Start from the frozen components and the entrypoints. Entrypoints are where flows begin.
2. Walk `get_neighbors` from each entrypoint. Call edges are the spine of both
   relationships and flows.
3. Check routes and stores against those paths. A route that reaches no store is worth
   noticing; so is a store nothing writes to.
4. Cite evidence for anything you mark `observed`.
5. Call `validate_slice` and fix what it reports.

## Watch for

- **A call edge is not a runtime path.** It shows the code references the callee. A flow
  built only from call edges is `inferred`, not `observed` — label it honestly.
- **Unresolved calls hide relationships.** The briefing says how many the scanner could
  not attribute. Where that number is large, your relationship graph is incomplete and a
  warning should say so.
- **Absent auth is not proven absent.** The scanner reports whether it *recognized* auth
  middleware in a file. It does not know your framework's conventions.
- **Do not restate structure as behaviour.** "The API component contains route handlers"
  is the foundation slice's fact. What those handlers *do* is this slice's.
