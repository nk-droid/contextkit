.PHONY: help install demo graph-test scan scan-self test web-install web-dev web-build

help:
	@echo "ContextKit"
	@echo ""
	@echo "Commands:"
	@echo "  make install   Make bin/contextkit executable"
	@echo "  make demo      Print a demo command"
	@echo "  make graph-test Validate graph fixtures and rules"
	@echo "  make scan REPO=<path>  Run static analysis on a repository"
	@echo "  make scan-self Run static analysis on ContextKit itself"
	@echo "  make test      Run every test suite"
	@echo "  make web-dev   Start the repository graph UI"
	@echo "  make web-build Typecheck, lint, and build the graph UI"

install:
	chmod +x bin/contextkit
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

test:
	node --test tests/*.test.mjs

web-install:
	npm --prefix web ci

web-dev:
	npm --prefix web run dev

web-build:
	npm --prefix web run typecheck
	npm --prefix web run lint
	npm --prefix web run build
