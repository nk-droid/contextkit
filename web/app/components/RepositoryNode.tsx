"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ExplorerNode } from "../graph/layout";

const labels: Record<string, string> = {
  external: "External",
  entrypoint: "Entry point",
  module: "Module",
  "data-store": "Data store",
  agent: "Agent",
  policy: "Policy",
  observability: "Telemetry",
  config: "Config",
  stage: "Stage",
  gate: "Gate",
  output: "Output",
};

export function RepositoryNode({ data, selected }: NodeProps<ExplorerNode>) {
  const horizontal = data.layoutDirection === "LR";
  const targetPosition = horizontal ? Position.Left : Position.Top;
  const sourcePosition = horizontal ? Position.Right : Position.Bottom;
  const detail = data.path ?? data.summary;

  return (
    <article
      className={`repository-node repository-node--${data.kind} ${
        selected ? "is-selected" : ""
      } ${data.isSearchMatch ? "" : "is-dimmed"} ${
        data.isNeighbor ? "is-neighbor" : ""
      } ${data.isInFocus ? "" : "is-recessed"}`}
    >
      <Handle type="target" position={targetPosition} className="node-handle" />
      <div className="node-heading">
        {data.viewKind === "runtime-flow" && data.sequenceNumber ? (
          <span className="runtime-step" aria-label={`Step ${data.sequenceNumber}`}>
            {String(data.sequenceNumber).padStart(2, "0")}
          </span>
        ) : (
          <span className="node-kind-dot" aria-hidden="true" />
        )}
        <span>{labels[data.kind] ?? data.kind}</span>
        {data.basis === "inferred" ? (
          <span className="inferred-mark">Inferred</span>
        ) : null}
      </div>
      <h3 title={data.label}>{data.label}</h3>
      <p title={detail}>{detail}</p>
      <Handle type="source" position={sourcePosition} className="node-handle" />
    </article>
  );
}
