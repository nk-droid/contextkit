## Working in your own session

You are running this slice yourself, inside an interactive session, rather than as a
provider ContextKit launched. Where this section and the instructions above disagree,
follow this section.

**The tools are commands.** Run each one as:

    node "{{contextkit}}/bin/contextkit-mcp" "{{run}}" call <tool> '<json-params>' --provider agent --slice {{slice}}

For large parameters, such as a `validate_slice` candidate, write them to a file and pass
`@<file>` in place of the JSON. Keep `--provider agent --slice {{slice}}` on every call:
it records the call and any evidence you resolve, and a result citing resolved evidence
that is missing from that record is rejected.

**The repository may be on disk.** If it is, you can read it to understand the code, but
do not modify it. Every evidence id must still come from this run: cite ids the facts
already carry, or resolve new ones with `resolve_evidence`. Scanner-measured values
follow the rules above.

**Submit a file instead of replying.** Write the result as one JSON object matching
`{{schema}}`, for example to `{{result}}`, then submit it:

    node "{{contextkit}}/bin/contextkit-analyze" "{{run}}" --slice {{slice}} --provider agent --result "{{result}}"

Submission applies the same rules as `validate_slice` and the assembler. If it lists
violations, fix them and submit again; only the latest submission is kept.
