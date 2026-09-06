Create a repository graph document for the target repository.

Use schema version 1. Set `repository.id` to the supplied repository slug, `repository.name` to the human-readable repository name, `repository.source` to the supplied source label, and `repository.revision` to the supplied Git revision when available.

Choose node kinds from: external, entrypoint, module, data-store, agent, policy, observability, config, stage, gate, output.

Use short node labels and summaries that explain responsibility. Edge labels should be brief verbs or relationships, such as "calls", "imports", "reads", "writes", "configures", or "emits". Add repository-relative evidence paths and concise evidence details wherever possible.
