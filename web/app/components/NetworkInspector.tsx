"use client";

import { useMemo } from "react";
import type { NetworkFacts } from "../facts/schema";
import {
  titleCase,
  type LayerDefinition,
  type LayerId,
  type NetworkLink,
  type NetworkModel,
  type NetworkNode,
} from "../facts/network";
import { cssColor, linkColors } from "../facts/orb";
import { githubSourceUrl } from "../source-links";

const shownDeclarations = 8;

/** What the enabled filters show, for the panel under the options. */
export function NetworkSummary({
  nodes,
  links,
  degree,
}: {
  nodes: NetworkNode[];
  links: NetworkLink[];
  degree: Map<string, Set<string>>;
}) {
  const hub = nodes.reduce<NetworkNode | null>(
    (best, node) =>
      (degree.get(node.id)?.size ?? 0) > (best ? degree.get(best.id)?.size ?? 0 : 0)
        ? node
        : best,
    null,
  );

  return (
    <section className="nw-rail-section nw-summary">
      <h2 className="nw-rail-heading">Showing</h2>
      <p className="nw-summary-lead">
        {nodes.length} nodes · {links.length} links
      </p>
      {hub ? (
        <p>
          Most connected: <b>{hub.name}</b> ({degree.get(hub.id)?.size ?? 0})
        </p>
      ) : null}
    </section>
  );
}

/** Everything known about the selected node, floating over the graph. */
export function NodeInspector({
  facts,
  model,
  node,
  links,
  layers,
  isVisible,
  onSelect,
  onClose,
}: {
  facts: NetworkFacts;
  model: NetworkModel;
  node: NetworkNode;
  links: NetworkLink[];
  layers: Map<LayerId, LayerDefinition>;
  isVisible: (id: string) => boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { repository } = facts;
  const connections = links.filter(
    (link) => link.source === node.id || link.target === node.id,
  );
  // A component's own declarations, most-called first, so code structure is
  // reachable from the architecture view.
  const declarations = useMemo(() => {
    if (node.family !== "component" || !model.code) return [];
    const callers = new Map<string, number>();
    model.code.calls.forEach((call) =>
      callers.set(call.calleeSymbolId, (callers.get(call.calleeSymbolId) ?? 0) + 1),
    );
    return model.code.symbols
      .filter((symbol) => symbol.componentId === node.id)
      .map((symbol) => ({ symbol, callers: callers.get(symbol.id) ?? 0 }))
      .sort((a, b) => b.callers - a.callers);
  }, [model, node]);
  const evidence = useMemo(() => {
    const byId = new Map(facts.evidence.map((record) => [record.id, record]));
    return node.grounding.evidenceIds.flatMap((id) => {
      const record = byId.get(id);
      return record ? [record] : [];
    });
  }, [facts, node]);
  const nameOf = (id: string) => model.nodeById.get(id)?.name ?? id;
  const ownership =
    node.family === "class" || node.family === "callable"
      ? node.owned
        ? "declaration"
        : "declaration outside any component"
      : node.owned
        ? "owned by this repository"
        : "external";

  return (
    <aside aria-label={`Details for ${node.name}`} className="nw-inspector">
      <div className="nw-inspector-top">
        <div className="nw-kind">
          {[titleCase(node.kind), ownership, node.lifecycle].filter(Boolean).join(" · ")}
        </div>
        <button aria-label="Close details" onClick={onClose} type="button">
          ×
        </button>
      </div>
      <h3>{node.name}</h3>
      {node.summary ? <p>{node.summary}</p> : null}

      {node.symbol ? (
        <>
          <div className="nw-k">Declaration</div>
          <p className="nw-note">
            <code>{node.symbol.qualifiedName || node.name}</code>
            <br />
            {[
              `${node.symbol.visibility} ${node.symbol.kind}`,
              node.symbol.componentId ? nameOf(node.symbol.componentId) : null,
              node.symbol.isEntrypoint ? "framework entrypoint" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </>
      ) : null}

      {node.responsibilities.length ? (
        <>
          <div className="nw-k">Responsibilities</div>
          <ul className="nw-list">
            {node.responsibilities.map((responsibility) => (
              <li key={responsibility}>{responsibility}</li>
            ))}
          </ul>
        </>
      ) : null}

      {declarations.length ? (
        <>
          <div className="nw-k">Declarations ({declarations.length})</div>
          {declarations.slice(0, shownDeclarations).map(({ symbol, callers }) => (
            <button
              className="nw-rel"
              disabled={!isVisible(symbol.id)}
              key={symbol.id}
              onClick={() => onSelect(symbol.id)}
              type="button"
            >
              <span className="nw-rel-top">
                <span className="nw-who">{symbol.name}</span>
                <span className="nw-via">
                  {symbol.kind}
                  {callers ? ` · ${callers} callers` : ""}
                </span>
              </span>
              <span className="nw-via">
                <code>
                  {symbol.path}:{symbol.lineStart}
                </code>
              </span>
            </button>
          ))}
          {declarations.length > shownDeclarations ? (
            <p className="nw-note">
              {declarations.length - shownDeclarations} more not shown.
            </p>
          ) : null}
        </>
      ) : null}

      <div className="nw-k">Connections ({connections.length})</div>
      {connections.length ? (
        connections.map((link) => {
          const outward = link.source === node.id;
          const other = outward ? link.target : link.source;
          const layer = layers.get(link.layer);
          return (
            <button
              className="nw-rel"
              key={link.key}
              onClick={() => onSelect(other)}
              type="button"
            >
              <span className="nw-rel-top">
                <span className="nw-arrow">
                  {link.bidirectional ? "↔" : !link.directed ? "—" : outward ? "→" : "←"}
                </span>
                <span className="nw-who">{nameOf(other)}</span>
              </span>
              <span
                className="nw-via"
                style={{ color: cssColor(linkColors[link.layer]) }}
              >
                {layer?.name ?? link.layer}
              </span>
              {link.items.map((item, index) => (
                <span className="nw-via" key={`${item.kind}-${index}`}>
                  · {item.kind}
                  {item.detail ? ` — ${item.detail}` : ""}
                </span>
              ))}
            </button>
          );
        })
      ) : (
        <p className="nw-note">No connections in the enabled layers.</p>
      )}

      {node.paths.length ? (
        <>
          <div className="nw-k">Paths</div>
          <div className="nw-paths">
            {node.paths.map((path) => (
              <code key={path}>{path}</code>
            ))}
          </div>
        </>
      ) : null}

      <div className="nw-k">Evidence ({evidence.length})</div>
      <p className="nw-note">
        {titleCase(node.grounding.basis)} · {node.grounding.confidence} confidence
      </p>
      {evidence.map((record) => {
        const lines = record.lineStart
          ? `:${record.lineStart}${
              record.lineEnd && record.lineEnd !== record.lineStart ? `–${record.lineEnd}` : ""
            }`
          : "";
        const url = githubSourceUrl(repository.canonicalRemote, repository.revision, record.path, {
          start: record.lineStart,
          end: record.lineEnd,
        });
        return (
          <div className="nw-rel" key={record.id}>
            <span className="nw-via">
              <code>
                {record.path}
                {lines}
              </code>
            </span>
            {record.detail ? <span className="nw-via">{record.detail}</span> : null}
            {url ? (
              <a className="nw-source-link" href={url} rel="noreferrer" target="_blank">
                Open at {repository.revision?.slice(0, 7)} ↗
              </a>
            ) : null}
          </div>
        );
      })}
    </aside>
  );
}
