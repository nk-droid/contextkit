import { z } from "zod";

export const graphNodeKinds = [
  "external",
  "entrypoint",
  "module",
  "data-store",
  "agent",
  "policy",
  "observability",
  "config",
  "stage",
  "gate",
  "output",
] as const;

const RelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("\\") &&
      !/^[a-zA-Z]:[\\/]/.test(value) &&
      !value.split(/[\\/]/).includes(".."),
    "Expected a safe repository-relative path",
  );

const EvidenceSchema = z
  .object({
    path: RelativePathSchema,
    detail: z.string().min(1).optional(),
  })
  .strict();

export const GraphNodeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(graphNodeKinds),
    path: RelativePathSchema.optional(),
    summary: z.string().min(1),
    basis: z.enum(["observed", "inferred"]),
    evidence: z.array(EvidenceSchema).default([]),
  })
  .strict();

export const GraphEdgeSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    kind: z.string().min(1),
    label: z.string().min(1),
    basis: z.enum(["observed", "inferred"]),
    evidence: z.array(EvidenceSchema).default([]),
  })
  .strict();

export const RepositoryGraphSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["architecture", "runtime-flow", "imports", "deployment"]),
    title: z.string().min(1),
    description: z.string().min(1),
    nodes: z.array(GraphNodeSchema).min(1).max(300),
    edges: z.array(GraphEdgeSchema).max(1000),
  })
  .strict()
  .superRefine((graph, context) => {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();

    graph.nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate node id: ${node.id}`,
          path: ["nodes", index, "id"],
        });
      }
      nodeIds.add(node.id);
      if (node.basis === "observed" && node.evidence.length === 0) {
        context.addIssue({
          code: "custom",
          message: "Observed nodes require evidence",
          path: ["nodes", index, "evidence"],
        });
      }
    });

    graph.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate edge id: ${edge.id}`,
          path: ["edges", index, "id"],
        });
      }
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        context.addIssue({
          code: "custom",
          message: `Dangling edge: ${edge.id}`,
          path: ["edges", index],
        });
      }
      if (edge.basis === "observed" && edge.evidence.length === 0) {
        context.addIssue({
          code: "custom",
          message: "Observed edges require evidence",
          path: ["edges", index, "evidence"],
        });
      }
    });
  });

export const RepoGraphFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        source: z.string().min(1),
        revision: z.string().nullable().optional(),
        description: z.string().min(1).optional(),
      })
      .strict(),
    graphs: z.array(RepositoryGraphSchema).min(1),
    warnings: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((document, context) => {
    const graphIds = new Set<string>();
    document.graphs.forEach((graph, index) => {
      if (graphIds.has(graph.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate graph id: ${graph.id}`,
          path: ["graphs", index, "id"],
        });
      }
      graphIds.add(graph.id);
    });
  });

export type GraphNodeData = z.infer<typeof GraphNodeSchema>;
export type GraphEdgeData = z.infer<typeof GraphEdgeSchema>;
export type RepositoryGraph = z.infer<typeof RepositoryGraphSchema>;
export type RepoGraphFile = z.infer<typeof RepoGraphFileSchema>;

export function parseRepoGraphFile(value: unknown): RepoGraphFile {
  return RepoGraphFileSchema.parse(value);
}
