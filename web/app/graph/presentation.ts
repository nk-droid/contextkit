import type { RepositoryGraph } from "./schema";

export type GraphKind = RepositoryGraph["kind"];

export const graphKindOrder: GraphKind[] = [
  "architecture",
  "runtime-flow",
  "imports",
  "deployment",
];

export const graphKindPresentation: Record<
  GraphKind,
  {
    label: string;
    icon: string;
    description: string;
    defaultDirection: "LR" | "TB";
  }
> = {
  architecture: {
    label: "Architecture",
    icon: "◇",
    description: "Services, modules, stores, and their structural relationships.",
    defaultDirection: "LR",
  },
  "runtime-flow": {
    label: "Runtime flow",
    icon: "↠",
    description: "Follow execution from entry point through each runtime step.",
    defaultDirection: "LR",
  },
  imports: {
    label: "Dependencies",
    icon: "⇄",
    description: "Inspect imports, shared packages, and dependency boundaries.",
    defaultDirection: "LR",
  },
  deployment: {
    label: "Deployment",
    icon: "▦",
    description: "See build artifacts, infrastructure, and deployment topology.",
    defaultDirection: "TB",
  },
};
