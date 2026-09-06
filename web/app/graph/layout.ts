import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import type { GraphEdgeData, GraphNodeData, RepositoryGraph } from "./schema";

export type LayoutDirection = "LR" | "TB";
export type EdgeLabelAnchor = "source" | "target" | "center";
export type ExplorerNode = Node<
  GraphNodeData & {
    isSearchMatch: boolean;
    isNeighbor: boolean;
    layoutDirection: LayoutDirection;
  },
  "repositoryNode"
>;
export type ExplorerEdge = Edge<
  GraphEdgeData & {
    layoutDirection: LayoutDirection;
    labelAnchor: EdgeLabelAnchor;
    showLabel: boolean;
    crowded: boolean;
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

function dimensionsForEdgeLabel(label: string) {
  const lines = estimatedLines(label, 25);
  return {
    width: clamp(label.length * 6.4, 84, 180),
    height: lines * 15 + 12,
  };
}

export function layoutGraph(
  graph: RepositoryGraph,
  direction: LayoutDirection,
  query: string,
  selectedNodeId: string | undefined,
  visibleKinds: Set<string>,
  visibleEdgeKinds: Set<string>,
  showInferred: boolean,
): { nodes: ExplorerNode[]; edges: ExplorerEdge[] } {
  const lowerQuery = query.trim().toLowerCase();
  const visibleNodes = graph.nodes.filter(
    (node) =>
      visibleKinds.has(node.kind) &&
      (showInferred || node.basis !== "inferred"),
  );
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = graph.edges.filter(
    (edge) =>
      visibleEdgeKinds.has(edge.kind) &&
      (showInferred || edge.basis !== "inferred") &&
      visibleIds.has(edge.source) &&
      visibleIds.has(edge.target),
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
    if (edges.length < 2 || edges.some((edge) => labelRepresentative.has(edge.id))) return;
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
    visibleNodes.map((node) => [node.id, dimensionsForNode(node)]),
  );
  visibleNodes.forEach((node) => dagreGraph.setNode(node.id, nodeDimensions.get(node.id)));
  visibleEdges.forEach((edge) => {
    const labelDimensions =
      labelRepresentative.get(edge.id) === "center"
        ? { width: 0, height: 0 }
        : dimensionsForEdgeLabel(edge.label);
    dagreGraph.setEdge(
      edge.source,
      edge.target,
      { ...labelDimensions, labelpos: "c", labeloffset: 14 },
      edge.id,
    );
  });
  dagre.layout(dagreGraph);

  return {
    nodes: visibleNodes.map((node) => {
      const position = dagreGraph.node(node.id);
      const dimensions = nodeDimensions.get(node.id) ?? {
        width: nodeWidth,
        height: 108,
      };
      const isSearchMatch =
        lowerQuery.length === 0 ||
        node.label.toLowerCase().includes(lowerQuery) ||
        node.path?.toLowerCase().includes(lowerQuery) === true ||
        node.summary.toLowerCase().includes(lowerQuery);
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
          layoutDirection: direction,
        },
        width: dimensions.width,
        height: dimensions.height,
        draggable: false,
        connectable: false,
      };
    }),
    edges: visibleEdges.map((edge) => {
      const incoming = incomingCount.get(edge.target) ?? 1;
      const outgoing = outgoingCount.get(edge.source) ?? 1;
      const groupedAnchor = labelRepresentative.get(edge.id);
      const belongsToIncomingGroup =
        (incomingLabelGroups.get(`${edge.target}\u0000${edge.label}`)?.length ?? 0) > 1;
      const belongsToOutgoingGroup =
        (outgoingLabelGroups.get(`${edge.source}\u0000${edge.label}`)?.length ?? 0) > 1;
      const showLabel = groupedAnchor !== "center";
      const labelAnchor: EdgeLabelAnchor = groupedAnchor ??
        (outgoing < incoming ? "source" : incoming < outgoing ? "target" : "center");

      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "repositoryEdge",
        data: {
          ...edge,
          layoutDirection: direction,
          labelAnchor,
          showLabel,
          crowded:
            incoming > 2 ||
            outgoing > 2 ||
            belongsToIncomingGroup ||
            belongsToOutgoingGroup,
        },
        animated: edge.kind === "publishes" || edge.kind === "dispatches",
        style: {
          stroke: edge.basis === "inferred" ? "#9f8f7d" : "#87999a",
          strokeWidth:
            selectedNodeId &&
            (edge.source === selectedNodeId || edge.target === selectedNodeId)
              ? 1.45
              : 0.9,
          strokeDasharray: edge.basis === "inferred" ? "5 5" : undefined,
          opacity:
            selectedNodeId &&
            edge.source !== selectedNodeId &&
            edge.target !== selectedNodeId
              ? 0.25
              : 0.8,
        },
      };
    }),
  };
}
