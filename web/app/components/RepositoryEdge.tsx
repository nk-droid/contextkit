"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import type { ExplorerEdge } from "../graph/layout";

export function RepositoryEdge({
  id,
  data,
  markerEnd,
  sourcePosition,
  sourceX,
  sourceY,
  style,
  targetPosition,
  targetX,
  targetY,
}: EdgeProps<ExplorerEdge>) {
  const pathArguments = {
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  };
  const [edgePath, centerX, centerY] = getBezierPath(pathArguments);
  const label = data?.label ?? "";
  const horizontal = data?.layoutDirection !== "TB";
  const anchor = data?.labelAnchor ?? "center";
  const distance = horizontal
    ? Math.abs(targetX - sourceX)
    : Math.abs(targetY - sourceY);
  const endpointOffset = Math.min(150, Math.max(76, distance * 0.28));
  const direction = horizontal
    ? Math.sign(targetX - sourceX) || 1
    : Math.sign(targetY - sourceY) || 1;
  const labelX = horizontal
    ? anchor === "source"
      ? sourceX + endpointOffset * direction
      : anchor === "target"
        ? targetX - endpointOffset * direction
        : centerX
    : anchor === "source"
      ? sourceX
      : anchor === "target"
        ? targetX
        : centerX;
  const labelY = horizontal
    ? anchor === "source"
      ? sourceY
      : anchor === "target"
        ? targetY
        : centerY
    : anchor === "source"
      ? sourceY + endpointOffset * direction
      : anchor === "target"
        ? targetY - endpointOffset * direction
        : centerY;

  return (
    <>
      <BaseEdge id={id} markerEnd={markerEnd} path={edgePath} style={style} />
      {label && data?.showLabel !== false ? (
        <EdgeLabelRenderer>
          <div
            className={`repository-edge-label ${
              data?.basis === "inferred" ? "is-inferred" : ""
            }`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            title={label}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
