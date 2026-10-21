"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  buildNetwork,
  neighbourSets,
  type LayerDefinition,
  type LayerId,
  type NodeFamily,
} from "../facts/network";
import { cssColor, linkColors, linkDashes, nodeColors } from "../facts/orb";
import type { NetworkFacts } from "../facts/schema";
import { NetworkSummary, NodeInspector } from "./NetworkInspector";
import { NetworkOrb } from "./NetworkOrb";
import { useTooltip } from "./NetworkTooltip";

function toggled<T>(current: Set<T>, value: T) {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function NetworkExplorer({
  facts,
  railHeader,
  railFooter,
}: {
  facts: NetworkFacts;
  railHeader: ReactNode;
  railFooter: ReactNode;
}) {
  const model = useMemo(() => buildNetwork(facts), [facts]);
  const [enabledLayers, setEnabledLayers] = useState(
    () => new Set(model.layers.filter((layer) => layer.defaultOn).map((layer) => layer.id)),
  );
  const [families, setFamilies] = useState(
    () => new Set(model.families.filter((family) => family.defaultOn).map((family) => family.id)),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tooltipRef, tooltip] = useTooltip();

  const layers = useMemo(
    () => new Map<LayerId, LayerDefinition>(model.layers.map((layer) => [layer.id, layer])),
    [model],
  );
  const familySizes = useMemo(() => {
    const sizes = new Map<NodeFamily, number>();
    model.nodes.forEach((node) => sizes.set(node.family, (sizes.get(node.family) ?? 0) + 1));
    return sizes;
  }, [model]);
  const layerSizes = useMemo(() => {
    const sizes = new Map<LayerId, number>();
    model.links.forEach((link) => sizes.set(link.layer, (sizes.get(link.layer) ?? 0) + 1));
    return sizes;
  }, [model]);
  const nodes = useMemo(
    () => model.nodes.filter((node) => families.has(node.family)),
    [families, model],
  );
  const links = useMemo(() => {
    const visible = new Set(nodes.map((node) => node.id));
    return model.links.filter(
      (link) =>
        enabledLayers.has(link.layer) && visible.has(link.source) && visible.has(link.target),
    );
  }, [enabledLayers, model, nodes]);
  const degree = useMemo(() => neighbourSets(nodes, links), [links, nodes]);
  const selectedNode = selectedId ? model.nodeById.get(selectedId) : undefined;
  // A node hidden by the family filters cannot stay selected.
  const selected = selectedNode && families.has(selectedNode.family) ? selectedNode : null;

  const toggleNode = useCallback(
    (id: string) => setSelectedId((current) => (current === id ? null : id)),
    [],
  );
  const clearSelection = useCallback(() => setSelectedId(null), []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  return (
    <>
      <aside className="nw-rail">
        {railHeader}
        <div className="nw-rail-body">
          <section className="nw-rail-section">
            <input
              aria-label="Find a component"
              className="nw-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a component…"
              type="search"
              value={query}
            />
          </section>

          <section className="nw-rail-section">
            <h2 className="nw-rail-heading">Show</h2>
            {model.families.map((family) => (
              <label className="nw-option" key={family.id}>
                <input
                  checked={families.has(family.id)}
                  onChange={() => setFamilies((current) => toggled(current, family.id))}
                  type="checkbox"
                />
                <span
                  className="nw-family-glyph"
                  style={{ background: cssColor(nodeColors[family.id]) }}
                />
                <span className="nw-option-name">{family.name}</span>
                <b>{familySizes.get(family.id) ?? 0}</b>
              </label>
            ))}
          </section>

          <section className="nw-rail-section">
            <h2 className="nw-rail-heading">Links</h2>
            {model.layers.map((layer) => (
              <label className="nw-option" key={layer.id} title={layer.note}>
                <input
                  checked={enabledLayers.has(layer.id)}
                  onChange={() => setEnabledLayers((current) => toggled(current, layer.id))}
                  type="checkbox"
                />
                <svg aria-hidden="true" className="nw-swatch" viewBox="0 0 22 4">
                  <line
                    stroke={cssColor(linkColors[layer.id])}
                    strokeDasharray={linkDashes[layer.id]?.join(" ")}
                    strokeWidth={2.5}
                    x1={0}
                    x2={22}
                    y1={2}
                    y2={2}
                  />
                </svg>
                <span className="nw-option-name">{layer.name}</span>
                <b>{layerSizes.get(layer.id) ?? 0}</b>
              </label>
            ))}
          </section>

          <NetworkSummary degree={degree} links={links} nodes={nodes} />
        </div>
        {railFooter}
      </aside>

      <main className="nw-main">
        <div className="nw-stage">
          <NetworkOrb
            degree={degree}
            links={links}
            nodes={nodes}
            onClearSelection={clearSelection}
            onToggleNode={toggleNode}
            query={query}
            selectedId={selected?.id ?? null}
            tooltip={tooltip}
          />
          {nodes.length ? null : (
            <p className="nw-stage-empty">No nodes are shown. Turn on a node type in the panel.</p>
          )}
          {selected ? (
            <NodeInspector
              facts={facts}
              isVisible={(id) => degree.has(id)}
              layers={layers}
              links={links}
              model={model}
              node={selected}
              onClose={clearSelection}
              onSelect={setSelectedId}
            />
          ) : null}
        </div>
      </main>

      <div aria-live="polite" className="nw-tip" ref={tooltipRef} role="status" />
    </>
  );
}
