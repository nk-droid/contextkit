"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
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
import { layoutGraph, type LayoutDirection } from "../graph/layout";
import {
  parseRepoGraphFile,
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
  const [direction, setDirection] = useState<LayoutDirection>("LR");
  const [query, setQuery] = useState("");
  const [showInferred, setShowInferred] = useState(true);
  const [visibleKinds, setVisibleKinds] = useState<Set<string>>(new Set());
  const [visibleEdgeKinds, setVisibleEdgeKinds] = useState<Set<string>>(
    new Set(),
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(true);
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
  const selectedNode =
    graph?.nodes.find((node) => node.id === selectedNodeId) ?? graph?.nodes[0];
  const availableKinds = useMemo(
    () => [...new Set(graph?.nodes.map((node) => node.kind) ?? [])].sort(),
    [graph],
  );
  const availableEdgeKinds = useMemo(
    () => [...new Set(graph?.edges.map((edge) => edge.kind) ?? [])].sort(),
    [graph],
  );
  const connectedEdges =
    graph?.edges.filter(
      (edge) =>
        edge.source === selectedNode?.id || edge.target === selectedNode?.id,
    ) ?? [];
  const matchingNodes =
    graph?.nodes.filter((node) => {
      const needle = query.trim().toLowerCase();
      return (
        !needle ||
        node.label.toLowerCase().includes(needle) ||
        node.path?.toLowerCase().includes(needle) ||
        node.summary.toLowerCase().includes(needle)
      );
    }).length ?? 0;
  const layout = useMemo(
    () =>
      graph
        ? layoutGraph(
            graph,
            direction,
            query,
            selectedNode?.id,
            visibleKinds,
            visibleEdgeKinds,
            showInferred,
          )
        : { nodes: [], edges: [] },
    [
      direction,
      graph,
      query,
      selectedNode?.id,
      showInferred,
      visibleEdgeKinds,
      visibleKinds,
    ],
  );

  const showMessage = useCallback((text: string, error = false) => {
    setMessage(text);
    setIsError(error);
    window.setTimeout(() => setMessage(null), 5000);
  }, []);

  const activateGraphFile = useCallback((graphFile: RepoGraphFile) => {
    const firstGraph = graphFile.graphs[0];
    setActiveRepository(graphFile);
    setGraphId(firstGraph.id);
    setSelectedNodeId(firstGraph.nodes[0].id);
    setVisibleKinds(new Set(firstGraph.nodes.map((node) => node.kind)));
    setVisibleEdgeKinds(new Set(firstGraph.edges.map((edge) => edge.kind)));
    setDetailOpen(true);
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
          error instanceof Error ? error.message : "Could not open repository library",
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
          minZoom: 0.38,
        }),
      60,
    );
    return () => window.clearTimeout(timeout);
  }, [direction, fitView, graph, showInferred, visibleEdgeKinds, visibleKinds]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const importFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      const candidates = [...files].filter(
        (file) =>
          file.name === "REPO_GRAPH.json" || file.name.endsWith(".json"),
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
    setSelectedNodeId(next.nodes[0].id);
    setVisibleKinds(new Set(next.nodes.map((node) => node.kind)));
    setVisibleEdgeKinds(new Set(next.edges.map((edge) => edge.kind)));
    setDetailOpen(true);
    setQuery("");
  };

  const toggleSetValue = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    value: string,
  ) => {
    setter((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

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
          <img className="atlas-brand-mark" src="/favicon.svg" alt="" width={31} height={31} />
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
                    <small>{repository.graphCount} views · {repository.nodeCount} nodes</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="no-repos">Your SQLite library is empty.</p>
          )}
        </section>

        {activeRepository ? (
          <nav className="graph-nav" aria-label="Graph views">
            <span className="section-label">Graph views</span>
            {activeRepository.graphs.map((candidate, index) => (
              <button
                className={candidate.id === graph?.id ? "is-active" : ""}
                key={candidate.id}
                onClick={() => selectGraph(candidate.id)}
              >
                <span className="nav-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>
                  <strong>{candidate.title}</strong>
                  <small>{candidate.nodes.length} nodes · {candidate.edges.length} links</small>
                </span>
              </button>
            ))}
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
              {loading ? "Checking SQLite…" : "Bring your first repository into view"}
            </h2>
            <p>
              Generate a <code>REPO_GRAPH.json</code> with ContextKit, then
              import it here. Its architecture and execution flows will be
              stored in SQLite.
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
              <span className="eyebrow">{activeRepository.repository.id}</span>
              <h1>{graph.title}</h1>
            </div>
            <div className="toolbar-actions">
              <label className="search-box">
                <span aria-hidden="true">⌕</span>
                <input
                  ref={searchInputRef}
                  aria-label="Search graph"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find module or path"
                  type="search"
                  value={query}
                />
                <kbd>⌘ K</kbd>
              </label>
              <div className="filter-wrap">
                <button
                  className={`filter-button ${filtersOpen ? "is-active" : ""}`}
                  onClick={() => setFiltersOpen((current) => !current)}
                >
                  Filters <span>{visibleKinds.size}/{availableKinds.length}</span>
                </button>
                {filtersOpen ? (
                  <div className="filter-menu">
                    <div className="filter-menu-heading">
                      <strong>Node types</strong>
                      <button onClick={() => setVisibleKinds(new Set(availableKinds))}>All</button>
                    </div>
                    {availableKinds.map((kind) => (
                      <label key={kind}>
                        <input
                          checked={visibleKinds.has(kind)}
                          onChange={() => toggleSetValue(setVisibleKinds, kind)}
                          type="checkbox"
                        />
                        <span className={`legend-dot legend-dot--${kind}`} />
                        {kind.replace("-", " ")}
                        <small>{graph.nodes.filter((node) => node.kind === kind).length}</small>
                      </label>
                    ))}
                    <div className="filter-menu-heading relationship-heading">
                      <strong>Relationships</strong>
                      <button onClick={() => setVisibleEdgeKinds(new Set(availableEdgeKinds))}>All</button>
                    </div>
                    {availableEdgeKinds.map((kind) => (
                      <label key={kind}>
                        <input
                          checked={visibleEdgeKinds.has(kind)}
                          onChange={() => toggleSetValue(setVisibleEdgeKinds, kind)}
                          type="checkbox"
                        />
                        <span className="edge-swatch" />
                        {kind.replace("_", " ")}
                        <small>{graph.edges.filter((edge) => edge.kind === kind).length}</small>
                      </label>
                    ))}
                    <label className="inferred-toggle">
                      <input
                        checked={showInferred}
                        onChange={(event) => setShowInferred(event.target.checked)}
                        type="checkbox"
                      />
                      Show inferred relationships
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
              <span>{graph.kind.replace("-", " ")}</span>
              <p>{graph.description}</p>
              {query ? <small>{matchingNodes} matching nodes</small> : null}
            </div>
            <ReactFlow
              colorMode="light"
              className="graph-stage"
              edgeTypes={edgeTypes}
              edges={layout.edges}
              fitView
              fitViewOptions={{ padding: 0.16, maxZoom: 0.95, minZoom: 0.38 }}
              minZoom={0.25}
              nodeTypes={nodeTypes}
              nodes={layout.nodes}
              nodesConnectable={false}
              nodesDraggable={false}
              onNodeClick={(_, node) => {
                setSelectedNodeId(node.id);
                setDetailOpen(true);
              }}
              onPaneClick={() => setDetailOpen(false)}
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
                zoomable
              />
              <Controls className="graph-controls" showInteractive={false} />
            </ReactFlow>
          </div>
        </section>
      )}

      {activeRepository && graph && selectedNode && detailOpen ? (
        <aside className="detail-panel">
          <div className="detail-topline">
            <span className={`type-pill type-pill--${selectedNode.kind}`}>
              {selectedNode.kind}
            </span>
            <button aria-label="Close details" onClick={() => setDetailOpen(false)}>×</button>
          </div>
          <h2>{selectedNode.label}</h2>
          {selectedNode.path ? <code className="path-chip">{selectedNode.path}</code> : null}
          <p className="detail-summary">{selectedNode.summary}</p>

          <section className="detail-section">
            <div className="detail-section-heading"><h3>Evidence</h3><span>{selectedNode.evidence.length}</span></div>
            <div className="evidence-list">
              {selectedNode.evidence.map((item) => (
                <button
                  className="evidence-item"
                  key={`${item.path}-${item.detail ?? ""}`}
                  onClick={() => void navigator.clipboard?.writeText(item.path)}
                  title="Copy repository path"
                >
                  <span aria-hidden="true">⌁</span>
                  <div><code>{item.path}</code>{item.detail ? <p>{item.detail}</p> : null}</div>
                </button>
              ))}
            </div>
          </section>

          <section className="detail-section relationships">
            <div className="detail-section-heading"><h3>Relationships</h3><span>{connectedEdges.length}</span></div>
            {connectedEdges.slice(0, 8).map((edge) => {
              const outward = edge.source === selectedNode.id;
              const otherId = outward ? edge.target : edge.source;
              const other = graph.nodes.find((node) => node.id === otherId);
              return (
                <button key={edge.id} onClick={() => setSelectedNodeId(otherId)}>
                  <span className="relation-arrow">{outward ? "→" : "←"}</span>
                  <span><small>{edge.label}</small><strong>{other?.label ?? otherId}</strong></span>
                </button>
              );
            })}
          </section>

          <footer className="detail-footer">
            <span className={selectedNode.basis === "observed" ? "verified" : "inferred"} />
            <p><strong>{selectedNode.basis === "observed" ? "Observed" : "Inferred"}</strong><br />from repository evidence</p>
          </footer>
        </aside>
      ) : null}

      {message ? (
        <div className={`load-toast ${isError ? "is-error" : ""}`}>{message}</div>
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
