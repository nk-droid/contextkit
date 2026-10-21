import type {
  CodeSymbol,
  Grounding,
  Lifecycle,
  NetworkFacts,
} from "./schema";

/*
 * Turns a context facts document into one graph: architecture entities
 * (components, external systems, stores) plus the declarations inside them.
 * Declared relationships become links directly; every other link is derived
 * from records that name two or more entities, such as a data contract's
 * producers and consumers or a risk's affected entities.
 */

export type NodeFamily = "component" | "external" | "store" | "class" | "callable";

export type LayerId =
  | "declared"
  | "flow"
  | "risk"
  | "shared"
  | "contains"
  | "cross"
  | "within";

export type NetworkNode = {
  id: string;
  name: string;
  kind: string;
  family: NodeFamily;
  summary: string;
  owned: boolean;
  lifecycle: Lifecycle | null;
  responsibilities: string[];
  paths: string[];
  grounding: Grounding;
  symbol: CodeSymbol | null;
};

export type LinkItem = { kind: string; detail: string };

export type NetworkLink = {
  key: string;
  source: string;
  target: string;
  layer: LayerId;
  items: LinkItem[];
  directed: boolean;
  bidirectional: boolean;
};

export type LayerDefinition = {
  id: LayerId;
  name: string;
  note: string;
  defaultOn: boolean;
};

export type FamilyDefinition = {
  id: NodeFamily;
  name: string;
  defaultOn: boolean;
};

export type NetworkModel = {
  nodes: NetworkNode[];
  nodeById: Map<string, NetworkNode>;
  links: NetworkLink[];
  layers: LayerDefinition[];
  families: FamilyDefinition[];
  code: NetworkFacts["code"] | null;
};

const architectureLayers: LayerDefinition[] = [
  {
    id: "declared",
    name: "Declared relationship",
    note: "Stated directly in the architecture facts.",
    defaultOn: true,
  },
  {
    id: "flow",
    name: "Data flow",
    note: "Derived from data contracts, API consumers and store access.",
    defaultOn: true,
  },
  {
    id: "risk",
    name: "Risk / trust",
    note: "Trust boundaries crossed, or a shared risk or finding.",
    defaultOn: true,
  },
  {
    id: "shared",
    name: "Shared resource",
    note: "Same dependency, config key or deployment target.",
    defaultOn: false,
  },
];

const codeLayers: LayerDefinition[] = [
  {
    id: "contains",
    name: "Declared in",
    note: "Connects a component to the declarations it owns.",
    defaultOn: true,
  },
  {
    id: "cross",
    name: "Call across components",
    note: "The call leaves its component, which is where coupling lives.",
    defaultOn: true,
  },
  {
    id: "within",
    name: "Call within a component",
    note: "Caller and callee belong to the same component.",
    defaultOn: false,
  },
];

// On a small codebase the cross-component calls are too sparse to read on
// their own, so calls inside a component start enabled there.
const sparseCrossCallLimit = 15;
// The orb relaxes every pair of nodes when it lays out and draws a glow per
// node on every frame, so a large declaration set starts hidden and the
// checkboxes offer it instead.
const declarationsShownByDefault = 400;

type RawLink = {
  source: string;
  target: string;
  layer: LayerId;
  item: LinkItem;
  directed: boolean;
  bidirectional: boolean;
};

function pairs(ids: string[]) {
  const result: [string, string][] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) result.push([ids[i], ids[j]]);
  }
  return result;
}

function ownsPath(componentPath: string, path: string) {
  const prefix = componentPath.replace(/\/+$/, "");
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function buildNetwork(facts: NetworkFacts): NetworkModel {
  const { architecture } = facts;
  const nodes: NetworkNode[] = [];
  const nodeById = new Map<string, NetworkNode>();
  const addNode = (node: NetworkNode) => {
    if (nodeById.has(node.id)) return;
    nodes.push(node);
    nodeById.set(node.id, node);
  };

  architecture.components.forEach((component) =>
    addNode({
      id: component.id,
      name: component.name,
      kind: component.kind,
      family: "component",
      summary: component.summary,
      owned: true,
      lifecycle: component.lifecycle,
      responsibilities: component.responsibilities,
      paths: component.paths,
      grounding: component.grounding,
      symbol: null,
    }),
  );
  architecture.externalSystems.forEach((system) =>
    addNode({
      id: system.id,
      name: system.name,
      kind: system.kind,
      family: "external",
      summary: system.purpose,
      owned: false,
      lifecycle: null,
      responsibilities: [],
      paths: [],
      grounding: system.grounding,
      symbol: null,
    }),
  );
  facts.data.stores.forEach((store) =>
    addNode({
      id: store.id,
      name: store.name,
      kind: store.kind,
      family: "store",
      summary: store.purpose,
      owned: false,
      lifecycle: null,
      responsibilities: [],
      paths: store.definitionPaths,
      grounding: store.grounding,
      symbol: null,
    }),
  );
  const architectureIds = new Set(nodes.map((node) => node.id));

  const raw: RawLink[] = [];
  const link = (
    source: string,
    target: string,
    layer: LayerId,
    kind: string,
    detail: string,
    directed: boolean,
    bidirectional = false,
  ) => {
    if (!architectureIds.has(source) || !architectureIds.has(target)) return;
    if (source === target) return;
    raw.push({ source, target, layer, item: { kind, detail }, directed, bidirectional });
  };
  const linkPairs = (ids: string[], layer: LayerId, kind: string, detail: string) =>
    pairs(ids.filter((id) => architectureIds.has(id))).forEach(([a, b]) =>
      link(a, b, layer, kind, detail, false),
    );

  architecture.relationships.forEach((relationship) =>
    link(
      relationship.sourceId,
      relationship.targetId,
      "declared",
      relationship.kind,
      relationship.summary || relationship.label,
      relationship.direction !== "bidirectional",
      relationship.direction === "bidirectional",
    ),
  );

  facts.interfaces.dataContracts.forEach((contract) =>
    contract.producerEntityIds.forEach((producer) =>
      contract.consumerEntityIds.forEach((consumer) =>
        link(producer, consumer, "flow", "produces → consumes", contract.name, true),
      ),
    ),
  );
  facts.data.stores.forEach((store) =>
    store.accessEntityIds.forEach((accessor) =>
      link(accessor, store.id, "flow", "accesses store", store.name, true),
    ),
  );
  facts.interfaces.apiSurfaces.forEach((surface) => {
    // A surface belongs to the components that list it as a public interface.
    // Without that, fall back to the components holding its handlers.
    let owners = architecture.components.filter((component) =>
      component.publicInterfaceIds.includes(surface.id),
    );
    if (!owners.length) {
      owners = architecture.components.filter((component) =>
        surface.endpoints.some((endpoint) =>
          component.paths.some((path) => ownsPath(path, endpoint.implementationPath)),
        ),
      );
    }
    surface.consumerEntityIds.forEach((consumer) =>
      owners.forEach((owner) =>
        link(consumer, owner.id, "flow", "consumes API", surface.name, true),
      ),
    );
  });

  facts.security.trustBoundaries.forEach((boundary) =>
    boundary.sourceEntityIds.forEach((source) =>
      boundary.targetEntityIds.forEach((target) =>
        link(source, target, "risk", "crosses trust boundary", boundary.name, true),
      ),
    ),
  );
  facts.quality.risks.forEach((risk) =>
    linkPairs(risk.affectedEntityIds, "risk", "shared risk", risk.title),
  );
  facts.security.findings.forEach((finding) =>
    linkPairs(finding.affectedEntityIds, "risk", "shared finding", finding.title),
  );

  facts.dependencies.forEach((dependency) =>
    linkPairs(dependency.usedByEntityIds, "shared", "shared dependency", dependency.name),
  );
  facts.operations.configurationKeys.forEach((key) =>
    linkPairs(key.consumerEntityIds, "shared", "shared config key", key.name),
  );
  facts.delivery.deploymentTargets.forEach((target) =>
    linkPairs(target.deployedEntityIds, "shared", "co-deployed", target.name),
  );
  facts.claims.forEach((claim) =>
    linkPairs(claim.relatedEntityIds, "shared", "co-cited in a claim", claim.statement),
  );

  // One rendered link per unordered pair and layer. The first record fixes
  // the drawing direction; a later record pointing the other way makes the
  // link bidirectional, and any undirected record makes it undirected.
  const aggregated = new Map<string, NetworkLink>();
  raw.forEach((entry) => {
    const key = `${[entry.source, entry.target].sort().join(" ")} ${entry.layer}`;
    let current = aggregated.get(key);
    if (!current) {
      current = {
        key,
        source: entry.source,
        target: entry.target,
        layer: entry.layer,
        items: [],
        directed: entry.directed,
        bidirectional: entry.bidirectional,
      };
      aggregated.set(key, current);
    }
    current.items.push(entry.item);
    if (entry.bidirectional) current.bidirectional = true;
    if (!entry.directed) current.directed = false;
    if (current.source !== entry.source && entry.directed) current.bidirectional = true;
  });
  const links = [...aggregated.values()];

  const code = facts.code.extraction.performed ? facts.code : null;
  const componentIds = new Set(architecture.components.map((component) => component.id));
  let layers = architectureLayers;
  let families: FamilyDefinition[] = [
    { id: "component", name: "Components", defaultOn: true },
    { id: "external", name: "External systems", defaultOn: true },
    { id: "store", name: "Data stores", defaultOn: true },
  ];

  if (code) {
    code.symbols.forEach((symbol) =>
      addNode({
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        family: symbol.kind === "class" ? "class" : "callable",
        summary: [symbol.signature || symbol.qualifiedName, symbol.summary]
          .filter(Boolean)
          .join(" — "),
        owned: Boolean(symbol.componentId && componentIds.has(symbol.componentId)),
        lifecycle: null,
        responsibilities: [],
        paths: [`${symbol.path}:${symbol.lineStart}`],
        grounding: symbol.grounding,
        symbol,
      }),
    );
    const symbolIds = new Set(nodes.filter((node) => node.symbol).map((node) => node.id));

    // Containment ties every declaration to the component that owns it,
    // which is what makes this one graph rather than two.
    nodes.forEach(({ symbol }) => {
      if (!symbol?.componentId || !componentIds.has(symbol.componentId)) return;
      links.push({
        key: `${symbol.componentId} ${symbol.id} contains`,
        source: symbol.componentId,
        target: symbol.id,
        layer: "contains",
        items: [{ kind: "declares", detail: `${symbol.path}:${symbol.lineStart}` }],
        directed: true,
        bidirectional: false,
      });
    });

    // Calls stay directed per caller and callee, so a pair calling each other
    // is drawn as two bowed links.
    const calls = new Map<string, NetworkLink>();
    code.calls.forEach((call) => {
      if (!symbolIds.has(call.callerSymbolId) || !symbolIds.has(call.calleeSymbolId)) return;
      if (call.callerSymbolId === call.calleeSymbolId) return;
      const key = `${call.callerSymbolId} ${call.calleeSymbolId} call`;
      let current = calls.get(key);
      if (!current) {
        current = {
          key,
          source: call.callerSymbolId,
          target: call.calleeSymbolId,
          layer: call.crossesComponent ? "cross" : "within",
          items: [],
          directed: true,
          bidirectional: false,
        };
        calls.set(key, current);
      }
      current.items.push({
        kind: call.resolution === "resolved" ? "calls" : "calls (name match)",
        detail: `lines ${call.callSiteLines.join(", ")}`,
      });
    });
    links.push(...calls.values());

    const crossCalls = [...calls.values()].filter((item) => item.layer === "cross").length;
    layers = [
      ...architectureLayers,
      ...codeLayers.map((layer) =>
        layer.id === "within" && crossCalls < sparseCrossCallLimit
          ? { ...layer, defaultOn: true }
          : layer,
      ),
    ];
    const showDeclarations = code.symbols.length <= declarationsShownByDefault;
    families = [
      ...families,
      { id: "class", name: "Classes", defaultOn: showDeclarations },
      { id: "callable", name: "Functions", defaultOn: showDeclarations },
    ];
  }

  return {
    nodes,
    nodeById,
    links,
    layers,
    families: families.filter((family) =>
      nodes.some((node) => node.family === family.id),
    ),
    code,
  };
}

/** Distinct neighbours of each node, counting only the links passed in. */
export function neighbourSets(nodes: NetworkNode[], links: NetworkLink[]) {
  const neighbours = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  links.forEach((item) => {
    const source = neighbours.get(item.source);
    const target = neighbours.get(item.target);
    if (!source || !target) return;
    source.add(item.target);
    target.add(item.source);
  });
  return neighbours;
}

export function nodeMatches(node: NetworkNode, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    node.name.toLowerCase().includes(needle) ||
    node.kind.toLowerCase().includes(needle) ||
    node.symbol?.qualifiedName.toLowerCase().includes(needle) === true
  );
}

export function titleCase(value: string) {
  return value.replace(/[-_.]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function truncate(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
