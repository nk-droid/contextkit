import dagre from "@dagrejs/dagre";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { GraphEdgeData, GraphNodeData, RepositoryGraph } from "./schema";

export type LayoutDirection = "LR" | "TB";
export type EdgeLabelAnchor = "source" | "target" | "center";
export type ExplorerNode = Node<
  GraphNodeData & {
    isSearchMatch: boolean;
    isNeighbor: boolean;
    isInFocus: boolean;
    layoutDirection: LayoutDirection;
    viewKind: RepositoryGraph["kind"];
    sequenceNumber?: number;
  },
  "repositoryNode"
>;
export type ExplorerEdge = Edge<
  GraphEdgeData & {
    layoutDirection: LayoutDirection;
    labelAnchor: EdgeLabelAnchor;
    showLabel: boolean;
    crowded: boolean;
    isSelected: boolean;
  },
  "repositoryEdge"
>;

const nodeWidth = 276;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function estimatedLines(value: string, charactersPerLine: number) {
  return clamp(Math.ceil(value.trim().length / charactersPerLine), 1, 3);
}

function dimensionsForNode(node: GraphNodeData) {
  const titleLines = estimatedLines(node.label, 29);
  const detailLines = estimatedLines(node.path ?? node.summary, 41);
  return {
    width: nodeWidth,
    height: clamp(54 + titleLines * 20 + detailLines * 15, 108, 154),
  };
}

export function layoutGraph(
  graph: RepositoryGraph,
  direction: LayoutDirection,
  query: string,
  selectedNodeId: string | undefined,
  selectedEdgeId: string | undefined,
  visibleKinds: Set<string>,
  visibleEdgeKinds: Set<string>,
  showInferred: boolean,
  hideIsolated: boolean,
): { nodes: ExplorerNode[]; edges: ExplorerEdge[] } {
  const lowerQuery = query.trim().toLowerCase();
  const filteredNodeIds = new Set(
    graph.nodes
      .filter(
        (node) =>
          visibleKinds.has(node.kind) &&
          (showInferred || node.basis !== "inferred"),
      )
      .map((node) => node.id),
  );
  const visibleEdges = graph.edges.filter(
    (edge) =>
      visibleEdgeKinds.has(edge.kind) &&
      (showInferred || edge.basis !== "inferred") &&
      filteredNodeIds.has(edge.source) &&
      filteredNodeIds.has(edge.target),
  );
  const connectedVisibleNodeIds = new Set(
    visibleEdges.flatMap((edge) => [edge.source, edge.target]),
  );
  const visibleNodeIds = hideIsolated
    ? new Set([...filteredNodeIds].filter((id) => connectedVisibleNodeIds.has(id)))
    : filteredNodeIds;
  const visibleEdgeIds = new Set(
    visibleEdges
      .filter(
        (edge) =>
          visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
      )
      .map((edge) => edge.id),
  );
  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  const incomingLabelGroups = new Map<string, GraphEdgeData[]>();
  const outgoingLabelGroups = new Map<string, GraphEdgeData[]>();

  visibleEdges.forEach((edge) => {
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
    outgoingCount.set(edge.source, (outgoingCount.get(edge.source) ?? 0) + 1);

    const incomingKey = `${edge.target}\u0000${edge.label}`;
    const outgoingKey = `${edge.source}\u0000${edge.label}`;
    incomingLabelGroups.set(incomingKey, [
      ...(incomingLabelGroups.get(incomingKey) ?? []),
      edge,
    ]);
    outgoingLabelGroups.set(outgoingKey, [
      ...(outgoingLabelGroups.get(outgoingKey) ?? []),
      edge,
    ]);
  });

  const labelRepresentative = new Map<string, EdgeLabelAnchor>();
  incomingLabelGroups.forEach((edges) => {
    if (edges.length < 2) return;
    const representative = edges[Math.floor(edges.length / 2)];
    edges.forEach((edge) => labelRepresentative.set(edge.id, "center"));
    labelRepresentative.set(representative.id, "target");
  });
  outgoingLabelGroups.forEach((edges) => {
    if (
      edges.length < 2 ||
      edges.some((edge) => labelRepresentative.has(edge.id))
    )
      return;
    const representative = edges[Math.floor(edges.length / 2)];
    edges.forEach((edge) => labelRepresentative.set(edge.id, "center"));
    labelRepresentative.set(representative.id, "source");
  });

  const neighborIds = new Set<string>();
  if (selectedNodeId) {
    visibleEdges.forEach((edge) => {
      if (edge.source === selectedNodeId) neighborIds.add(edge.target);
      if (edge.target === selectedNodeId) neighborIds.add(edge.source);
    });
  }
  if (selectedEdgeId) {
    const selectedEdge = visibleEdges.find((edge) => edge.id === selectedEdgeId);
    if (selectedEdge) {
      neighborIds.add(selectedEdge.source);
      neighborIds.add(selectedEdge.target);
    }
  }

  // Keep positions stable while filtering by laying out the complete graph.
  const dagreGraph = new dagre.graphlib.Graph({ multigraph: true });
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({
    rankdir: direction,
    ranksep: direction === "LR" ? 184 : 132,
    nodesep: direction === "LR" ? 72 : 62,
    edgesep: 38,
    marginx: 72,
    marginy: 72,
    acyclicer: "greedy",
  });
  const nodeDimensions = new Map(
    graph.nodes.map((node) => [node.id, dimensionsForNode(node)]),
  );
  graph.nodes.forEach((node) =>
    dagreGraph.setNode(node.id, nodeDimensions.get(node.id)),
  );
  // Sized edge labels make Dagre insert an extra rank per edge, which doubles the
  // real gap between nodes. Labels are overlay-rendered, so they need no space here.
  graph.edges.forEach((edge) => {
    dagreGraph.setEdge(
      edge.source,
      edge.target,
      { width: 0, height: 0 },
      edge.id,
    );
  });
  dagre.layout(dagreGraph);

  const hasSelection = Boolean(selectedNodeId || selectedEdgeId);
  const showOverviewLabels = visibleEdges.length <= 12 && !hasSelection;

  return {
    nodes: graph.nodes.map((node, index) => {
      const position = dagreGraph.node(node.id);
      const dimensions = nodeDimensions.get(node.id) ?? {
        width: nodeWidth,
        height: 108,
      };
      const isSearchMatch =
        lowerQuery.length === 0 ||
        node.label.toLowerCase().includes(lowerQuery) ||
        node.path?.toLowerCase().includes(lowerQuery) === true ||
        node.summary.toLowerCase().includes(lowerQuery) ||
        node.evidence.some((item) =>
          item.path.toLowerCase().includes(lowerQuery),
        );
      return {
        id: node.id,
        type: "repositoryNode",
        position: {
          x: position.x - dimensions.width / 2,
          y: position.y - dimensions.height / 2,
        },
        data: {
          ...node,
          isSearchMatch,
          isNeighbor: neighborIds.has(node.id),
          isInFocus:
            !hasSelection ||
            node.id === selectedNodeId ||
            neighborIds.has(node.id),
          layoutDirection: direction,
          viewKind: graph.kind,
          sequenceNumber: graph.kind === "runtime-flow" ? index + 1 : undefined,
        },
        hidden: !visibleNodeIds.has(node.id),
        selected: node.id === selectedNodeId,
        width: dimensions.width,
        height: dimensions.height,
        draggable: false,
        connectable: false,
      };
    }),
    edges: graph.edges.map((edge) => {
      const incoming = incomingCount.get(edge.target) ?? 1;
      const outgoing = outgoingCount.get(edge.source) ?? 1;
      const groupedAnchor = labelRepresentative.get(edge.id);
      const belongsToIncomingGroup =
        (incomingLabelGroups.get(`${edge.target}\u0000${edge.label}`)?.length ??
          0) > 1;
      const belongsToOutgoingGroup =
        (outgoingLabelGroups.get(`${edge.source}\u0000${edge.label}`)?.length ??
          0) > 1;
      const isSelected = edge.id === selectedEdgeId;
      const isIncident =
        Boolean(selectedNodeId) &&
        (edge.source === selectedNodeId || edge.target === selectedNodeId);
      const groupedOut = groupedAnchor === "center";
      const showLabel =
        isSelected || (!groupedOut && (isIncident || showOverviewLabels));
      const labelAnchor: EdgeLabelAnchor =
        groupedAnchor ??
        (outgoing < incoming
          ? "source"
          : incoming < outgoing
            ? "target"
            : "center");
      const isInFocus = !hasSelection || isSelected || isIncident;
      const strokeColor = isSelected
        ? "#ed6b4d"
        : edge.basis === "inferred"
          ? "#9f8f7d"
          : "#87999a";

      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "repositoryEdge",
        hidden: !visibleEdgeIds.has(edge.id),
        selected: isSelected,
        data: {
          ...edge,
          layoutDirection: direction,
          labelAnchor,
          showLabel,
          isSelected,
          crowded:
            incoming > 2 ||
            outgoing > 2 ||
            belongsToIncomingGroup ||
            belongsToOutgoingGroup,
        },
        animated:
          graph.kind === "runtime-flow" &&
          isInFocus &&
          (edge.kind === "publishes" || edge.kind === "dispatches"),
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: strokeColor,
          // Markers scale with stroke width, so keep the arrow readable on thin edges.
          width: isSelected ? 11 : isIncident ? 14 : 20,
          height: isSelected ? 11 : isIncident ? 14 : 20,
        },
        style: {
          stroke: strokeColor,
          strokeWidth: isSelected ? 1.7 : isIncident ? 1.3 : 0.85,
          strokeDasharray: edge.basis === "inferred" ? "5 5" : undefined,
          opacity: isInFocus ? 0.82 : 0.14,
        },
      };
    }),
  };
}
