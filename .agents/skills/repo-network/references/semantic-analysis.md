# Semantic analysis by the agent

You take the place of the provider for ContextKit's two semantic slices: `foundation` (components, external systems, users, capabilities), then `behavior-data` (relationships, runtime flows, boundaries, data). ContextKit prepares each slice, checks what you submit with the same rules it applies to Claude Code and Codex, and assembles the export.

`ck` below means `<skill-dir>/scripts/contextkit`.

1. **Scan.** This writes a static export, which stays as the fallback, and prints the run directory:

   ```bash
   ck network <repo> --output <file>
   ```

   Use the `Run:` directory it prints for every later step.

2. **Prepare `foundation`.**

   ```bash
   ck analyze <run-dir> --slice foundation --provider agent --prepare
   ```

   It prints the prompt file, the output schema, where to write your result, and the submit command. Read the prompt in full: it holds the rules, the briefing, and the exact tool commands for this run.

3. **Analyze.** Explore with the tool commands from the prompt. If the repository is on disk you can read it too, but cite only evidence ids from the run.

4. **Submit and fix.** Write the result JSON and run the submit command. A rejected submission lists each violation; fix them and submit again until it prints `VALID`. A valid foundation freezes the component and external-system ids that the next slice references.

5. **Repeat steps 2 to 4 for `behavior-data`.**

6. **Export.**

   ```bash
   ck network <run-dir> --provider agent --output <file>
   ```

   It reuses your validated slices, assembles the network, checks it, and replaces the static export.

If you stop partway, the run directory keeps every prompt, submission, and validation report. Resume from the first slice that isn't valid yet.

ContextKit can't confine you the way it confines a headless provider, which runs in an empty directory and reaches facts only through the MCP server. Validation still rejects evidence that isn't from the run and any change to scanner-measured values.
