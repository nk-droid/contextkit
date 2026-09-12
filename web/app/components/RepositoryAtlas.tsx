"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import Image from "next/image";
import { layoutGraph, type LayoutDirection } from "../graph/layout";
import {
  graphKindOrder,
  graphKindPresentation,
} from "../graph/presentation";
import {
  parseRepoGraphFile,
  type GraphEdgeData,
  type GraphNodeData,
  type RepoGraphFile,
} from "../graph/schema";
import { RepositoryNode } from "./RepositoryNode";
import { RepositoryEdge } from "./RepositoryEdge";

type RepositorySummary = {
  id: string;
  name: string;
  source: string;
  revision: string | null;
  description: string | null;
  schemaVersion: number;
  graphCount: number;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  updatedAt: string;
};

type InspectorTab = "overview" | "evidence" | "relationships";

const nodeTypes = { repositoryNode: RepositoryNode };
const edgeTypes = { repositoryEdge: RepositoryEdge };

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function nodeMatches(node: GraphNodeData, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    node.label.toLowerCase().includes(needle) ||
    node.path?.toLowerCase().includes(needle) === true ||
    node.summary.toLowerCase().includes(needle) ||
    node.evidence.some(
      (item) =>
        item.path.toLowerCase().includes(needle) ||
        item.detail?.toLowerCase().includes(needle) === true,
    )
  );
}

function githubEvidenceUrl(
  source: string,
  revision: string | null | undefined,
  path: string,
) {
  if (!revision) return null;
  if (!/^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(source))
    return null;
  const repositoryUrl = source.replace(/\/$/, "").replace(/\.git$/i, "");
  const safePath = path.split("/").map(encodeURIComponent).join("/");
  return `${repositoryUrl}/blob/${encodeURIComponent(revision)}/${safePath}`;
}

async function responseError(response: Response) {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string; issues?: { path: string; message: string }[] }
    | null;
  const issue = payload?.issues?.[0];
  return issue
    ? `${payload?.error}: ${issue.path} ${issue.message}`
    : payload?.error ?? `Request failed (${response.status})`;
}

function Atlas() {
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [activeRepository, setActiveRepository] =
    useState<RepoGraphFile | null>(null);
  const [graphId, setGraphId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [direction, setDirection] = useState<LayoutDirection>("LR");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [showInferred, setShowInferred] = useState(true);
  const [hideIsolated, setHideIsolated] = useState(false);
  const [visibleKinds, setVisibleKinds] = useState<Set<string>>(new Set());
  const [visibleEdgeKinds, setVisibleEdgeKinds] = useState<Set<string>>(
    new Set(),
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("overview");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { fitView } = useReactFlow();

  const graph =
    activeRepository?.graphs.find((candidate) => candidate.id === graphId) ??
    activeRepository?.graphs[0];
  const selectedNode = graph?.nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = graph?.edges.find((edge) => edge.id === selectedEdgeId);
  const presentation = graph ? graphKindPresentation[graph.kind] : null;
  const availableKinds = useMemo(
    () => [...new Set(graph?.nodes.map((node) => node.kind) ?? [])].sort(),
    [graph],
  );
  const availableEdgeKinds = useMemo(
    () => [...new Set(graph?.edges.map((edge) => edge.kind) ?? [])].sort(),
    [graph],
  );
  const excludedKinds = availableKinds.filter((kind) => !visibleKinds.has(kind));
  const excludedEdgeKinds = availableEdgeKinds.filter(
    (kind) => !visibleEdgeKinds.has(kind),
  );
  const activeFilterCount =
    excludedKinds.length +
    excludedEdgeKinds.length +
    (showInferred ? 0 : 1) +
    (hideIsolated ? 1 : 0);

  const nodeIsVisible = useCallback(
    (node: GraphNodeData) =>
      visibleKinds.has(node.kind) &&
      (showInferred || node.basis !== "inferred"),
    [showInferred, visibleKinds],
  );
  const edgeIsVisible = useCallback(
    (edge: GraphEdgeData) =>
      Boolean(graph) &&
      visibleEdgeKinds.has(edge.kind) &&
      (showInferred || edge.basis !== "inferred") &&
      graph!.nodes.some(
        (node) => node.id === edge.source && nodeIsVisible(node),
      ) &&
      graph!.nodes.some(
        (node) => node.id === edge.target && nodeIsVisible(node),
      ),
    [graph, nodeIsVisible, showInferred, visibleEdgeKinds],
  );
  const matchingSearchNodes = useMemo(
    () =>
      query.trim() && graph
        ? graph.nodes
            .filter((node) => nodeIsVisible(node) && nodeMatches(node, query))
        : [],
    [graph, nodeIsVisible, query],
  );
  const searchResults = matchingSearchNodes.slice(0, 10);
  const matchingNodes = matchingSearchNodes.length;
  const connectedEdges = useMemo(
    () =>
      selectedNode && graph
        ? graph.edges.filter(
            (edge) =>
              edgeIsVisible(edge) &&
              (edge.source === selectedNode.id ||
                edge.target === selectedNode.id),
          )
        : [],
    [edgeIsVisible, graph, selectedNode],
  );
  const evidencePathCount = useMemo(() => {
    if (!graph) return 0;
    return new Set(
      [...graph.nodes, ...graph.edges].flatMap((item) =>
        item.evidence.map((evidence) => evidence.path),
      ),
    ).size;
  }, [graph]);
  const selectedEvidence = selectedNode?.evidence ?? selectedEdge?.evidence ?? [];
  const selectedBasis = selectedNode?.basis ?? selectedEdge?.basis;
  const runtimeStepIndex = graph?.nodes.findIndex(
    (node) => node.id === selectedNodeId,
  ) ?? -1;
  const layout = useMemo(
    () =>
      graph
        ? layoutGraph(
            graph,
            direction,
            query,
            selectedNode?.id,
            selectedEdge?.id,
            visibleKinds,
            visibleEdgeKinds,
            showInferred,
            hideIsolated,
          )
        : { nodes: [], edges: [] },
    [
      direction,
      graph,
      hideIsolated,
      query,
      selectedEdge?.id,
      selectedNode?.id,
      showInferred,
      visibleEdgeKinds,
      visibleKinds,
    ],
  );
  const visibleNodeCount = layout.nodes.filter((node) => !node.hidden).length;
  const visibleEdgeCount = layout.edges.filter((edge) => !edge.hidden).length;

  const showMessage = useCallback((text: string, error = false) => {
    setMessage(text);
    setIsError(error);
    window.setTimeout(() => setMessage(null), 5000);
  }, []);

  const resetInspector = useCallback(() => {
    setSelectedNodeId("");
    setSelectedEdgeId("");
    setDetailOpen(false);
    setInspectorTab("overview");
  }, []);

  const activateGraphFile = useCallback((graphFile: RepoGraphFile) => {
    const firstGraph =
      graphFile.graphs.find((candidate) => candidate.kind === "architecture") ??
      graphFile.graphs[0];
    setActiveRepository(graphFile);
    setGraphId(firstGraph.id);
    setDirection(graphKindPresentation[firstGraph.kind].defaultDirection);
    setSelectedNodeId("");
    setSelectedEdgeId("");
    setVisibleKinds(new Set(firstGraph.nodes.map((node) => node.kind)));
    setVisibleEdgeKinds(new Set(firstGraph.edges.map((edge) => edge.kind)));
    setShowInferred(true);
    setHideIsolated(false);
    setDetailOpen(false);
    setInspectorTab("overview");
    setQuery("");
  }, []);

  const refreshRepositories = useCallback(async () => {
    const response = await fetch("/api/repositories", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    const payload = (await response.json()) as {
      repositories: RepositorySummary[];
    };
    setRepositories(payload.repositories);
    return payload.repositories;
  }, []);

  const loadRepository = useCallback(
    async (repositoryId: string) => {
      setLoading(true);
      try {
        const response = await fetch(
          `/api/repositories?id=${encodeURIComponent(repositoryId)}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error(await responseError(response));
        const payload = (await response.json()) as {
          repository: RepoGraphFile;
        };
        activateGraphFile(parseRepoGraphFile(payload.repository));
      } catch (error) {
        showMessage(
          error instanceof Error ? error.message : "Could not load repository",
          true,
        );
      } finally {
        setLoading(false);
      }
    },
    [activateGraphFile, showMessage],
  );

  useEffect(() => {
    void (async () => {
      try {
        const stored = await refreshRepositories();
        if (stored[0]) await loadRepository(stored[0].id);
      } catch (error) {
        showMessage(
          error instanceof Error
            ? error.message
            : "Could not open repository library",
          true,
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [loadRepository, refreshRepositories, showMessage]);

  useEffect(() => {
    if (!graph) return;
    const timeout = window.setTimeout(
      () =>
        fitView({
          padding: 0.16,
          duration: 350,
          maxZoom: 0.95,
          minZoom: 0.25,
        }),
      60,
    );
    return () => window.clearTimeout(timeout);
  }, [direction, fitView, graph]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        if (query) setSearchOpen(true);
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setFiltersOpen(false);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [query]);

  const importFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      const candidates = [...files].filter(
        (file) => file.name === "REPO_GRAPH.json" || file.name.endsWith(".json"),
      );
      let latest: RepoGraphFile | null = null;
      const failures: string[] = [];

      for (const file of candidates) {
        try {
          const parsed = parseRepoGraphFile(JSON.parse(await file.text()));
          const response = await fetch("/api/repositories", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(parsed),
          });
          if (!response.ok) throw new Error(await responseError(response));
          latest = parsed;
        } catch (error) {
          failures.push(
            `${file.name}: ${
              error instanceof Error ? error.message : "invalid graph"
            }`,
          );
        }
      }

      if (latest) {
        activateGraphFile(latest);
        await refreshRepositories();
      }
      if (!candidates.length) {
        showMessage("No JSON graph files were found.", true);
      } else if (failures.length) {
        showMessage(
          `${candidates.length - failures.length} saved · ${failures[0]}`,
          true,
        );
      } else {
        showMessage(
          `${candidates.length} ${
            candidates.length === 1 ? "repository" : "repositories"
          } saved to SQLite.`,
        );
      }
    },
    [activateGraphFile, refreshRepositories, showMessage],
  );

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    void importFiles(event.target.files);
    event.target.value = "";
  };

  const selectGraph = (nextGraphId: string) => {
    const next = activeRepository?.graphs.find(
      (candidate) => candidate.id === nextGraphId,
    );
    if (!next) return;
    setGraphId(next.id);
    setDirection(graphKindPresentation[next.kind].defaultDirection);
    setSelectedNodeId("");
    setSelectedEdgeId("");
    setVisibleKinds(new Set(next.nodes.map((node) => node.kind)));
    setVisibleEdgeKinds(new Set(next.edges.map((edge) => edge.kind)));
    setShowInferred(true);
    setHideIsolated(false);
    setDetailOpen(false);
    setInspectorTab("overview");
    setFiltersOpen(false);
    setQuery("");
  };

  const focusNodes = useCallback(
    (ids: string[]) => {
      window.setTimeout(
        () =>
          fitView({
            nodes: ids.map((id) => ({ id })),
            padding: 0.5,
            duration: 350,
            maxZoom: 1.12,
          }),
        20,
      );
    },
    [fitView],
  );

  const selectNode = useCallback(
    (nodeId: string, focus = false) => {
      setSelectedNodeId(nodeId);
      setSelectedEdgeId("");
      setInspectorTab("overview");
      setDetailOpen(true);
      setSearchOpen(false);
      if (focus) focusNodes([nodeId]);
    },
    [focusNodes],
  );

  const selectEdge = useCallback(
    (edgeId: string, focus = false) => {
      const edge = graph?.edges.find((candidate) => candidate.id === edgeId);
      if (!edge) return;
      setSelectedEdgeId(edgeId);
      setSelectedNodeId("");
      setInspectorTab("overview");
      setDetailOpen(true);
      setSearchOpen(false);
      if (focus) focusNodes([edge.source, edge.target]);
    },
    [focusNodes, graph],
  );

  const resetFilters = () => {
    if (!graph) return;
    setVisibleKinds(new Set(graph.nodes.map((node) => node.kind)));
    setVisibleEdgeKinds(new Set(graph.edges.map((edge) => edge.kind)));
    setShowInferred(true);
    setHideIsolated(false);
  };

  const toggleSetValue = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    value: string,
  ) => {
    resetInspector();
    setter((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && searchResults.length) {
      event.preventDefault();
      setSearchOpen(true);
      setActiveSearchIndex((current) => (current + 1) % searchResults.length);
    } else if (event.key === "ArrowUp" && searchResults.length) {
      event.preventDefault();
      setSearchOpen(true);
      setActiveSearchIndex(
        (current) => (current - 1 + searchResults.length) % searchResults.length,
      );
    } else if (event.key === "Enter" && searchResults.length) {
      event.preventDefault();
      selectNode(searchResults[activeSearchIndex]?.id ?? searchResults[0].id, true);
    } else if (event.key === "Escape") {
      setSearchOpen(false);
    }
  };

  const stepRuntime = (offset: number) => {
    if (!graph?.nodes.length) return;
    const current = runtimeStepIndex < 0 ? (offset > 0 ? -1 : 0) : runtimeStepIndex;
    const next = (current + offset + graph.nodes.length) % graph.nodes.length;
    selectNode(graph.nodes[next].id, true);
  };

  const copyEvidence = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      showMessage(`Copied ${path}`);
    } catch {
      showMessage("Could not copy the evidence path.", true);
    }
  };

  const edgeSource = selectedEdge
    ? graph?.nodes.find((node) => node.id === selectedEdge.source)
    : null;
  const edgeTarget = selectedEdge
    ? graph?.nodes.find((node) => node.id === selectedEdge.target)
    : null;
  const detailTitle = selectedNode?.label ?? selectedEdge?.label;
  const detailKind = selectedNode?.kind ?? (selectedEdge ? "relationship" : "");
  const repositoryRevision = activeRepository?.repository.revision;
  const revisionLabel = repositoryRevision
    ? repositoryRevision.slice(0, 8)
    : "working tree";

  return (
    <main
      className={`atlas-shell ${
        activeRepository && detailOpen ? "" : "detail-closed"
      }`}
    >
      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept=".json,application/json"
        multiple
        onChange={handleFiles}
      />
      <input
        ref={folderInputRef}
        className="visually-hidden"
        type="file"
        multiple
        onChange={handleFiles}
        {...{ webkitdirectory: "", directory: "" }}
      />

      <aside className="atlas-sidebar">
        <div className="atlas-brand">
          <Image
            className="atlas-brand-mark"
            src="/favicon.svg"
            alt=""
            width={31}
            height={31}
          />
          <div>
            <strong>ContextKit</strong>
            <span>Repository atlas</span>
          </div>
        </div>

        <section className="repo-library">
          <span className="section-label">Repositories</span>
          {repositories.length ? (
            <div className="repo-list">
              {repositories.map((repository) => (
                <button
                  className={
                    activeRepository?.repository.id === repository.id
                      ? "is-active"
                      : ""
                  }
                  key={repository.id}
                  onClick={() => void loadRepository(repository.id)}
                >
                  <span className="repo-avatar">{initials(repository.name)}</span>
                  <span>
                    <strong>{repository.name}</strong>
                    <small>
                      {repository.graphCount} views · {repository.nodeCount} nodes
                    </small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="no-repos">Your SQLite library is empty.</p>
          )}
        </section>

        {activeRepository ? (
          <nav className="graph-nav" aria-label="Repository lenses">
            <span className="section-label">Repository lenses</span>
            {graphKindOrder.map((kind) => {
              const candidate = activeRepository.graphs.find(
                (item) => item.kind === kind,
              );
              const item = graphKindPresentation[kind];
              return (
                <button
                  aria-current={candidate?.id === graph?.id ? "page" : undefined}
                  className={`${candidate?.id === graph?.id ? "is-active" : ""} ${
                    candidate ? "" : "is-unavailable"
                  }`}
                  disabled={!candidate}
                  key={kind}
                  onClick={() => candidate && selectGraph(candidate.id)}
                  title={candidate ? candidate.title : `${item.label} was not generated`}
                >
                  <span className="view-icon" aria-hidden="true">{item.icon}</span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>
                      {candidate
                        ? `${candidate.nodes.length} nodes · ${candidate.edges.length} relationships`
                        : "Not generated"}
                    </small>
                  </span>
                </button>
              );
            })}
          </nav>
        ) : null}

        <div className="sidebar-imports">
          <button onClick={() => fileInputRef.current?.click()}>
            <span>＋</span> Add graph files
          </button>
          <button onClick={() => folderInputRef.current?.click()}>
            <span>⌁</span> Open pack folder
          </button>
        </div>
        <div className="sidebar-note">
          <span className="note-icon">i</span>
          <p>Repository graphs are validated and stored in SQLite.</p>
        </div>
      </aside>

      {!activeRepository || !graph ? (
        <section className="empty-workspace">
          <header>
            <div>
              <span>Repository library</span>
              <h1>Understand a codebase at a glance.</h1>
            </div>
            <button onClick={() => fileInputRef.current?.click()}>
              Import graph
            </button>
          </header>
          <div className="empty-card">
            <div className="empty-symbol">
              <span />
              <span />
              <span />
              <i />
            </div>
            <span className="eyebrow">
              {loading ? "Opening library" : "No repositories yet"}
            </span>
            <h2>
              {loading
                ? "Checking SQLite…"
                : "Bring your first repository into view"}
            </h2>
            <p>
              Generate a <code>REPO_GRAPH.json</code> with ContextKit, then
              import it here. Architecture, runtime, dependency, and deployment
              views are stored in SQLite.
            </p>
            <button onClick={() => fileInputRef.current?.click()}>
              Choose graph file
            </button>
            <small>Nothing is seeded. Your library starts empty.</small>
          </div>
        </section>
      ) : (
        <section className="workspace">
          <header className="toolbar">
            <div>
              <span className="eyebrow">
                {activeRepository.repository.name} · {revisionLabel}
              </span>
              <h1>{graph.title}</h1>
            </div>
            <div className="toolbar-actions">
              <div className="search-wrap">
                <label className="search-box">
                  <span aria-hidden="true">⌕</span>
                  <input
                    ref={searchInputRef}
                    aria-controls="graph-search-results"
                    aria-expanded={searchOpen && Boolean(query)}
                    aria-label="Search graph"
                    role="combobox"
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setActiveSearchIndex(0);
                      setSearchOpen(Boolean(event.target.value));
                    }}
                    onFocus={() => query && setSearchOpen(true)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder="Find module or path"
                    type="search"
                    value={query}
                  />
                  {query ? (
                    <button
                      aria-label="Clear search"
                      className="search-clear"
                      onClick={() => {
                        setQuery("");
                        setSearchOpen(false);
                        searchInputRef.current?.focus();
                      }}
                      type="button"
                    >
                      ×
                    </button>
                  ) : (
                    <kbd>⌘ K</kbd>
                  )}
                </label>
                {searchOpen && query ? (
                  <div
                    className="search-results"
                    id="graph-search-results"
                    role="listbox"
                  >
                    <div className="search-results-heading">
                      <span>Matches in this view</span>
                      <small>{matchingNodes}</small>
                    </div>
                    {searchResults.length ? (
                      searchResults.map((node, index) => (
                        <button
                          aria-selected={index === activeSearchIndex}
                          className={index === activeSearchIndex ? "is-active" : ""}
                          key={node.id}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setActiveSearchIndex(index)}
                          onClick={() => selectNode(node.id, true)}
                          role="option"
                        >
                          <span className={`legend-dot legend-dot--${node.kind}`} />
                          <span>
                            <strong>{node.label}</strong>
                            <small>{node.path ?? node.summary}</small>
                          </span>
                          <em>{humanize(node.kind)}</em>
                        </button>
                      ))
                    ) : (
                      <p className="search-empty">No visible nodes match “{query}”.</p>
                    )}
                    <div className="search-help">↑↓ move · Enter inspect · Esc close</div>
                  </div>
                ) : null}
              </div>

              <div className="basis-switch" aria-label="Evidence basis">
                <button
                  aria-pressed={showInferred}
                  className={showInferred ? "is-active" : ""}
                  onClick={() => {
                    resetInspector();
                    setShowInferred(true);
                  }}
                >
                  All
                </button>
                <button
                  aria-pressed={!showInferred}
                  className={!showInferred ? "is-active" : ""}
                  onClick={() => {
                    resetInspector();
                    setShowInferred(false);
                  }}
                >
                  Observed
                </button>
              </div>

              <div className="filter-wrap">
                <button
                  aria-expanded={filtersOpen}
                  className={`filter-button ${
                    filtersOpen || activeFilterCount ? "is-active" : ""
                  }`}
                  onClick={() => setFiltersOpen((current) => !current)}
                >
                  Filters <span>{activeFilterCount || "All"}</span>
                </button>
                {filtersOpen ? (
                  <div className="filter-menu">
                    <div className="filter-menu-title">
                      <strong>Filter this lens</strong>
                      <button disabled={!activeFilterCount} onClick={resetFilters}>
                        Reset
                      </button>
                    </div>
                    <div className="filter-menu-heading">
                      <strong>Node types</strong>
                      <button
                        onClick={() => setVisibleKinds(new Set(availableKinds))}
                      >
                        All
                      </button>
                    </div>
                    {availableKinds.map((kind) => (
                      <label key={kind}>
                        <input
                          checked={visibleKinds.has(kind)}
                          onChange={() => toggleSetValue(setVisibleKinds, kind)}
                          type="checkbox"
                        />
                        <span className={`legend-dot legend-dot--${kind}`} />
                        {humanize(kind)}
                        <small>
                          {graph.nodes.filter((node) => node.kind === kind).length}
                        </small>
                      </label>
                    ))}
                    <div className="filter-menu-heading relationship-heading">
                      <strong>Relationships</strong>
                      <button
                        onClick={() =>
                          setVisibleEdgeKinds(new Set(availableEdgeKinds))
                        }
                      >
                        All
                      </button>
                    </div>
                    {availableEdgeKinds.map((kind) => (
                      <label key={kind}>
                        <input
                          checked={visibleEdgeKinds.has(kind)}
                          onChange={() =>
                            toggleSetValue(setVisibleEdgeKinds, kind)
                          }
                          type="checkbox"
                        />
                        <span className="edge-swatch" />
                        {humanize(kind)}
                        <small>
                          {graph.edges.filter((edge) => edge.kind === kind).length}
                        </small>
                      </label>
                    ))}
                    <label className="inferred-toggle">
                      <input
                        checked={hideIsolated}
                        onChange={(event) => {
                          resetInspector();
                          setHideIsolated(event.target.checked);
                        }}
                        type="checkbox"
                      />
                      Hide unconnected nodes
                    </label>
                  </div>
                ) : null}
              </div>

              <div className="direction-switch" aria-label="Layout direction">
                <button
                  aria-label="Horizontal layout"
                  className={direction === "LR" ? "is-active" : ""}
                  onClick={() => setDirection("LR")}
                >
                  →
                </button>
                <button
                  aria-label="Vertical layout"
                  className={direction === "TB" ? "is-active" : ""}
                  onClick={() => setDirection("TB")}
                >
                  ↓
                </button>
              </div>
              <button
                className="import-button"
                onClick={() => fileInputRef.current?.click()}
              >
                Import graph <span>↗</span>
              </button>
            </div>
          </header>

          <div className="canvas-wrap">
            <div className="canvas-caption">
              <div className="caption-main">
                <span className="lens-pill">{presentation?.label}</span>
                <div>
                  <p>{graph.description}</p>
                  <small>
                    {visibleNodeCount} nodes · {visibleEdgeCount} relationships ·{" "}
                    {evidencePathCount} evidence paths
                  </small>
                </div>
                {graph.kind === "runtime-flow" ? (
                  <div className="runtime-controls" aria-label="Runtime steps">
                    <button aria-label="Previous runtime step" onClick={() => stepRuntime(-1)}>←</button>
                    <span>
                      {runtimeStepIndex >= 0
                        ? `Step ${runtimeStepIndex + 1} of ${graph.nodes.length}`
                        : `${graph.nodes.length} steps`}
                    </span>
                    <button aria-label="Next runtime step" onClick={() => stepRuntime(1)}>→</button>
                  </div>
                ) : query ? (
                  <span className="match-count">{matchingNodes} matches</span>
                ) : null}
              </div>
              {activeFilterCount ? (
                <div className="filter-chips" aria-label="Active filters">
                  {excludedKinds.map((kind) => (
                    <button
                      key={`node-${kind}`}
                      onClick={() => toggleSetValue(setVisibleKinds, kind)}
                    >
                      {humanize(kind)} hidden <span>×</span>
                    </button>
                  ))}
                  {excludedEdgeKinds.map((kind) => (
                    <button
                      key={`edge-${kind}`}
                      onClick={() => toggleSetValue(setVisibleEdgeKinds, kind)}
                    >
                      {humanize(kind)} hidden <span>×</span>
                    </button>
                  ))}
                  {!showInferred ? (
                    <button onClick={() => setShowInferred(true)}>
                      Observed only <span>×</span>
                    </button>
                  ) : null}
                  {hideIsolated ? (
                    <button onClick={() => setHideIsolated(false)}>
                      Connected only <span>×</span>
                    </button>
                  ) : null}
                  <button className="clear-filters" onClick={resetFilters}>
                    Clear all
                  </button>
                </div>
              ) : null}
            </div>
            <ReactFlow
              colorMode="light"
              className="graph-stage"
              edgeTypes={edgeTypes}
              edges={layout.edges}
              fitView
              fitViewOptions={{ padding: 0.16, maxZoom: 0.95, minZoom: 0.25 }}
              minZoom={0.25}
              nodeTypes={nodeTypes}
              nodes={layout.nodes}
              nodesConnectable={false}
              nodesDraggable={false}
              onEdgeClick={(_, edge) => selectEdge(edge.id)}
              onNodeClick={(_, node) => selectNode(node.id)}
              onPaneClick={resetInspector}
              onlyRenderVisibleElements
              proOptions={{ hideAttribution: true }}
            >
              <Background
                color="#d7d0c5"
                gap={28}
                size={1.1}
                variant={BackgroundVariant.Dots}
              />
              <MiniMap
                className="graph-minimap"
                maskColor="rgba(245, 240, 232, 0.82)"
                nodeColor={(node) =>
                  node.id === selectedNode?.id ? "#ef6f51" : "#214e50"
                }
                pannable
                // React Flow derives the svg size and viewport mask from these, so
                // they must live here rather than in CSS.
                style={{ width: 132, height: 88 }}
                zoomable
              />
              <Controls className="graph-controls" showInteractive={false} />
            </ReactFlow>
            <div className="basis-legend" aria-label="Graph evidence legend">
              <span><i className="observed-line" />Observed</span>
              <span><i className="inferred-line" />Inferred</span>
            </div>
          </div>
        </section>
      )}

      {activeRepository && graph && detailTitle && detailOpen ? (
        <aside className="detail-panel">
          <div className="detail-topline">
            <div className="detail-badges">
              <span className={`type-pill type-pill--${detailKind}`}>
                {humanize(detailKind)}
              </span>
              <span className={`basis-pill basis-pill--${selectedBasis}`}>
                {selectedBasis}
              </span>
            </div>
            <button aria-label="Close details" onClick={resetInspector}>×</button>
          </div>
          <h2>{detailTitle}</h2>
          {selectedNode?.path ? (
            <code className="path-chip">{selectedNode.path}</code>
          ) : null}

          <div className="inspector-tabs" role="tablist" aria-label="Inspector sections">
            {(["overview", "evidence", "relationships"] as InspectorTab[]).map(
              (tab) => (
                <button
                  aria-selected={inspectorTab === tab}
                  className={inspectorTab === tab ? "is-active" : ""}
                  key={tab}
                  onClick={() => setInspectorTab(tab)}
                  role="tab"
                >
                  {tab}
                  {tab === "evidence" ? <span>{selectedEvidence.length}</span> : null}
                  {tab === "relationships" && selectedNode ? (
                    <span>{connectedEdges.length}</span>
                  ) : null}
                </button>
              ),
            )}
          </div>

          <div className="inspector-content">
            {inspectorTab === "overview" ? (
              <section className="overview-panel">
                {selectedNode ? (
                  <>
                    <span className="detail-label">Responsibility</span>
                    <p className="detail-summary">{selectedNode.summary}</p>
                    <dl className="detail-metadata">
                      <div><dt>Node type</dt><dd>{humanize(selectedNode.kind)}</dd></div>
                      <div><dt>Evidence basis</dt><dd>{selectedNode.basis}</dd></div>
                    </dl>
                  </>
                ) : selectedEdge ? (
                  <>
                    <span className="detail-label">Relationship</span>
                    <div className="edge-route">
                      <strong>{edgeSource?.label ?? selectedEdge.source}</strong>
                      <span>→</span>
                      <strong>{edgeTarget?.label ?? selectedEdge.target}</strong>
                    </div>
                    <dl className="detail-metadata">
                      <div><dt>Relationship type</dt><dd>{humanize(selectedEdge.kind)}</dd></div>
                      <div><dt>Evidence basis</dt><dd>{selectedEdge.basis}</dd></div>
                    </dl>
                  </>
                ) : null}
              </section>
            ) : null}

            {inspectorTab === "evidence" ? (
              <section className="detail-section evidence-section">
                <div className="detail-section-heading">
                  <h3>Repository evidence</h3>
                  <span>{selectedEvidence.length}</span>
                </div>
                {selectedEvidence.length ? (
                  <div className="evidence-list">
                    {selectedEvidence.map((item) => {
                      const sourceUrl = githubEvidenceUrl(
                        activeRepository.repository.source,
                        repositoryRevision,
                        item.path,
                      );
                      return (
                        <article
                          className="evidence-item"
                          key={`${item.path}-${item.detail ?? ""}`}
                        >
                          <span aria-hidden="true">⌁</span>
                          <div>
                            <code>{item.path}</code>
                            {item.detail ? <p>{item.detail}</p> : null}
                            <div className="evidence-actions">
                              {sourceUrl ? (
                                <a href={sourceUrl} target="_blank" rel="noreferrer">
                                  Open at {revisionLabel} ↗
                                </a>
                              ) : null}
                              <button onClick={() => void copyEvidence(item.path)}>
                                Copy path
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="inspector-empty">
                    <span>○</span>
                    <p>No repository path was attached to this item.</p>
                  </div>
                )}
              </section>
            ) : null}

            {inspectorTab === "relationships" ? (
              <section className="detail-section relationships">
                <div className="detail-section-heading">
                  <h3>{selectedNode ? "Connected items" : "Endpoints"}</h3>
                  <span>{selectedNode ? connectedEdges.length : 2}</span>
                </div>
                {selectedNode ? (
                  connectedEdges.length ? (
                    connectedEdges.map((edge) => {
                      const outward = edge.source === selectedNode.id;
                      const otherId = outward ? edge.target : edge.source;
                      const other = graph.nodes.find((node) => node.id === otherId);
                      return (
                        <button key={edge.id} onClick={() => selectEdge(edge.id, true)}>
                          <span className="relation-arrow">{outward ? "→" : "←"}</span>
                          <span>
                            <small>{edge.label}</small>
                            <strong>{other?.label ?? otherId}</strong>
                          </span>
                          <em className={`relation-basis relation-basis--${edge.basis}`}>
                            {edge.basis}
                          </em>
                        </button>
                      );
                    })
                  ) : (
                    <div className="inspector-empty">
                      <span>○</span>
                      <p>No relationships are visible with the current filters.</p>
                    </div>
                  )
                ) : (
                  <div className="endpoint-list">
                    {[edgeSource, edgeTarget].map((node, index) =>
                      node ? (
                        <button key={node.id} onClick={() => selectNode(node.id, true)}>
                          <span>{index === 0 ? "Source" : "Target"}</span>
                          <strong>{node.label}</strong>
                          <small>{node.path ?? humanize(node.kind)}</small>
                        </button>
                      ) : null,
                    )}
                  </div>
                )}
              </section>
            ) : null}
          </div>

          <footer className="detail-footer">
            <span className={selectedBasis === "observed" ? "verified" : "inferred"} />
            <p>
              <strong>{selectedBasis === "observed" ? "Observed" : "Inferred"}</strong>
              <br />
              {selectedBasis === "observed"
                ? "Backed by repository evidence"
                : "Model-inferred from repository context"}
            </p>
          </footer>
        </aside>
      ) : null}

      {message ? (
        <div className={`load-toast ${isError ? "is-error" : ""}`}>
          {message}
        </div>
      ) : null}
    </main>
  );
}

export function RepositoryAtlas() {
  return (
    <ReactFlowProvider>
      <Atlas />
    </ReactFlowProvider>
  );
}
