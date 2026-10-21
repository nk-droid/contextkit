.PHONY: help install demo graph-test scan scan-self mcp mcp-probe test install-skills sync-skills web-install web-dev web-build

help:
	@echo "ContextKit"
	@echo ""
	@echo "Commands:"
	@echo "  make install   Install CLI dependencies and enable the commands"
	@echo "  make demo      Print a demo command"
	@echo "  make graph-test Validate graph fixtures and rules"
	@echo "  make scan REPO=<path>  Run static analysis on a repository"
	@echo "  make scan-self Run static analysis on ContextKit itself"
	@echo "  make mcp RUN=<dir> ARGS='<cmd>'  Inspect a run through the MCP layer"
	@echo "  make mcp-probe RUN=<dir>  Check the access boundary with fake providers"
	@echo "  make test      Run every test suite"
	@echo "  make install-skills  Link the agent skills into ~/.claude/skills and ~/.agents/skills"
	@echo "  make sync-skills  Refresh the files the repo-graph skill bundles"
	@echo "  make web-dev   Start the repository graph UI"
	@echo "  make web-build Typecheck, lint, and build the graph UI"

install:
	npm ci --ignore-scripts
	chmod +x bin/contextkit bin/contextkit-network bin/contextkit-export-network
	@echo "Add this to your shell profile:"
	@echo "export PATH=$$(pwd)/bin:\$$PATH"

demo:
	@echo "contextkit generate https://github.com/owner/repo --audience human"
	@echo "contextkit generate ~/work/private-repo --all --output ~/Desktop/repo-context"
	@echo "contextkit generate ~/work/private-repo --all --with-graph"

graph-test:
	node --test tests/*.test.mjs

# Deterministic static analysis. Produces STATIC_ANALYSIS.json and the private
# SOURCE_INDEX.jsonl, and exits non-zero when the artifact fails validation.
scan:
	@test -n "$(REPO)" || (echo "usage: make scan REPO=/path/to/repository" && exit 2)
	node bin/contextkit-scan "$(REPO)" $(SCAN_ARGS)

scan-self:
	node bin/contextkit-scan . $(SCAN_ARGS)

# Inspect a completed run exactly as a model provider would see it. Reads the frozen
# artifacts only; the scanned repository is never consulted.
mcp:
	@test -n "$(RUN)" || (echo "usage: make mcp RUN=<run-dir> ARGS='summary'" && exit 2)
	node bin/contextkit-mcp "$(RUN)" $(ARGS)

# Exits non-zero if a hostile provider gets through or a cooperative one is blocked.
mcp-probe:
	@test -n "$(RUN)" || (echo "usage: make mcp-probe RUN=<run-dir>" && exit 2)
	node bin/contextkit-mcp "$(RUN)" probe

test:
	node --test tests/*.test.mjs

# Skills meant for use on any repository. Skills for working on ContextKit itself stay out.
SKILLS := repo-context repo-graph
SKILLS_DIRS ?= $(HOME)/.claude/skills $(HOME)/.agents/skills

# Claude Code reads the first directory; Codex and most other agents read the second.
# Links point at this checkout. Existing real directories are left alone.
install-skills:
	@for dir in $(SKILLS_DIRS); do \
	  mkdir -p "$$dir"; \
	  for skill in $(SKILLS); do \
	    link="$$dir/$$skill"; \
	    if [ -e "$$link" ] && [ ! -L "$$link" ]; then \
	      echo "skipped $$link: exists and is not a symlink"; \
	    else \
	      ln -sfn "$(CURDIR)/.agents/skills/$$skill" "$$link" && echo "linked $$link"; \
	    fi; \
	  done; \
	done

# repo-graph carries copies of these so it works outside this checkout.
sync-skills:
	cp scripts/validate-graph.mjs .agents/skills/repo-graph/scripts/validate-graph.mjs
	cp schemas/repo-graph.schema.json .agents/skills/repo-graph/references/repo-graph.schema.json

web-install:
	npm ci --ignore-scripts
	npm --prefix web ci

web-dev:
	npm --prefix web run dev

web-build:
	npm --prefix web run typecheck
	npm --prefix web run lint
	npm --prefix web run build
