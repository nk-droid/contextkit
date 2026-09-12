"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { useMemo } from "react";
import type { ExplorerEdge } from "../graph/layout";

const labelPositionRatio = 0.26;

function pointOnPath(path: string, ratio: number) {
  if (typeof document === "undefined") return null;
  const element = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );
  element.setAttribute("d", path);
  const length = element.getTotalLength();
  if (!length) return null;
  const { x, y } = element.getPointAtLength(length * ratio);
  return { x, y };
}

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
  const anchor = data?.labelAnchor ?? "center";
  // Sample the drawn curve so endpoint-anchored labels sit on the edge rather than
  // on a straight line between its handles.
  const anchorPoint = useMemo(
    () =>
      anchor === "center"
        ? null
        : pointOnPath(
            edgePath,
            anchor === "source"
              ? labelPositionRatio
              : 1 - labelPositionRatio,
          ),
    [anchor, edgePath],
  );
  const labelX = anchorPoint?.x ?? centerX;
  const labelY = anchorPoint?.y ?? centerY;

  return (
    <>
      <BaseEdge id={id} markerEnd={markerEnd} path={edgePath} style={style} />
      {label && data?.showLabel !== false ? (
        <EdgeLabelRenderer>
          <div
            className={`repository-edge-label ${
              data?.basis === "inferred" ? "is-inferred" : ""
            } ${data?.isSelected ? "is-selected" : ""}`}
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
