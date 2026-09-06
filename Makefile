.PHONY: help install demo graph-test web-install web-dev web-build

help:
	@echo "ContextKit"
	@echo ""
	@echo "Commands:"
	@echo "  make install   Make bin/contextkit executable"
	@echo "  make demo      Print a demo command"
	@echo "  make graph-test Validate graph fixtures and rules"
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

web-install:
	npm --prefix web ci

web-dev:
	npm --prefix web run dev

web-build:
	npm --prefix web run typecheck
	npm --prefix web run lint
	npm --prefix web run build
