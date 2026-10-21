import { z } from "zod";
const RelativePathSchema = z.string().min(1).refine((value) =>
  !value.startsWith("/") && !value.startsWith("\\") &&
  !/^[a-zA-Z]:[\\/]/.test(value) && !value.split(/[\\/]/).includes(".."),
  "Expected a safe repository-relative path");

/*
 * The part of a context facts document that the component network reads.
 *
 * Field names, enums, and nullability follow ContextFactsDocument in
 * schemas/context-facts.schema.json,
 * but only the fields the network uses are declared. Zod drops undeclared
 * fields while parsing, so parsing a complete facts document yields this
 * projection. That keeps inventory, guidance, and evidence excerpts out of
 * the browser upload and out of D1. This projection does not claim that the
 * complete context-facts document has been generated.
 */

const StableIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9._:-]*$/, "Expected a stable id");
const StableIdsSchema = z.array(StableIdSchema);
const PathsSchema = z.array(RelativePathSchema);

export const lifecycles = /** @type {const} */ ([
  "active",
  "experimental",
  "deprecated",
  "legacy",
  "planned",
  "unknown",
]);

const GroundingSchema = z.object({
  basis: z.enum(["observed", "documented", "inferred"]),
  confidence: z.enum(["high", "medium", "low", "unknown"]),
  evidenceIds: StableIdsSchema,
});

const RepositoryIdentitySchema = z.object({
  id: StableIdSchema,
  name: z.string().min(1),
  displayName: z.string(),
  sourceLabel: z.string(),
  canonicalRemote: z.string().nullable(),
  revision: z.string().nullable(),
});

const ComponentSchema = z.object({
  id: StableIdSchema,
  name: z.string(),
  kind: z.string(),
  lifecycle: z.enum(lifecycles),
  summary: z.string(),
  responsibilities: z.array(z.string()),
  paths: PathsSchema,
  publicInterfaceIds: StableIdsSchema,
  grounding: GroundingSchema,
});

const ExternalSystemSchema = z.object({
  id: StableIdSchema,
  name: z.string(),
  kind: z.string(),
  purpose: z.string(),
  required: z.boolean(),
  grounding: GroundingSchema,
});

const RelationshipSchema = z.object({
  sourceId: StableIdSchema,
  targetId: StableIdSchema,
  kind: z.string(),
  label: z.string(),
  summary: z.string(),
  direction: z.string(),
});

const DataStoreSchema = z.object({
  id: StableIdSchema,
  name: z.string(),
  kind: z.string(),
  purpose: z.string(),
  accessEntityIds: StableIdsSchema,
  definitionPaths: PathsSchema,
  grounding: GroundingSchema,
});

const DataContractSchema = z.object({
  name: z.string(),
  producerEntityIds: StableIdsSchema,
  consumerEntityIds: StableIdsSchema,
});

const ApiSurfaceSchema = z.object({
  id: StableIdSchema,
  name: z.string(),
  consumerEntityIds: StableIdsSchema,
  endpoints: z.array(z.object({ implementationPath: RelativePathSchema })),
});

const TrustBoundarySchema = z.object({
  name: z.string(),
  sourceEntityIds: StableIdsSchema,
  targetEntityIds: StableIdsSchema,
});

// SecurityFinding and RiskRecord share the fields the network reads.
const AffectingRecordSchema = z.object({
  title: z.string(),
  affectedEntityIds: StableIdsSchema,
});

const DependencySchema = z.object({
  name: z.string(),
  usedByEntityIds: StableIdsSchema,
});

const ConfigurationKeySchema = z.object({
  name: z.string(),
  consumerEntityIds: StableIdsSchema,
});

const DeploymentTargetSchema = z.object({
  name: z.string(),
  deployedEntityIds: StableIdsSchema,
});

const ClaimSchema = z.object({
  statement: z.string(),
  relatedEntityIds: StableIdsSchema,
});

const CodeSymbolSchema = z.object({
  id: StableIdSchema,
  name: z.string(),
  qualifiedName: z.string(),
  kind: z.enum(["module", "class", "function", "method", "property"]),
  path: RelativePathSchema,
  lineStart: z.int().min(1),
  signature: z.string().nullable(),
  summary: z.string(),
  componentId: StableIdSchema.nullable(),
  visibility: z.enum(["public", "internal", "private"]),
  isEntrypoint: z.boolean(),
  grounding: GroundingSchema,
});

const CallEdgeSchema = z.object({
  callerSymbolId: StableIdSchema,
  calleeSymbolId: StableIdSchema,
  callSiteLines: z.array(z.int()),
  resolution: z.enum(["resolved", "heuristic", "unresolved"]),
  crossesComponent: z.boolean(),
});

const CodeModelSchema = z.object({
  extraction: z.object({ performed: z.boolean() }),
  symbols: z.array(CodeSymbolSchema),
  calls: z.array(CallEdgeSchema),
});

const EvidenceSchema = z.object({
  id: StableIdSchema,
  path: RelativePathSchema,
  lineStart: z.int().min(1).nullable(),
  lineEnd: z.int().min(1).nullable(),
  detail: z.string(),
});

export const NetworkFactsSchema = z
  .object({
    schemaVersion: z.literal(1),
    coverage: z.object({
      mode: z.enum(["static", "semantic"]),
      completedSlices: z.array(z.string()),
      missingLayers: z.array(z.string()),
      unsupportedLanguages: z.array(z.string()),
      unresolvedCalls: z.int().min(0),
      discoveredSymbols: z.int().min(0),
      retainedSymbols: z.int().min(0),
      unownedSymbols: z.int().min(0),
    }).optional(),
    warnings: z.array(z.string()).default([]),
    artifactId: StableIdSchema,
    repository: RepositoryIdentitySchema,
    // ContextFactsDocument defaults `code` to an extraction that did not run.
    code: CodeModelSchema.default({
      extraction: { performed: false },
      symbols: [],
      calls: [],
    }),
    dependencies: z.array(DependencySchema),
    architecture: z.object({
      components: z.array(ComponentSchema),
      externalSystems: z.array(ExternalSystemSchema),
      relationships: z.array(RelationshipSchema),
    }),
    interfaces: z.object({
      apiSurfaces: z.array(ApiSurfaceSchema),
      dataContracts: z.array(DataContractSchema),
    }),
    data: z.object({ stores: z.array(DataStoreSchema) }),
    operations: z.object({
      configurationKeys: z.array(ConfigurationKeySchema),
    }),
    delivery: z.object({
      deploymentTargets: z.array(DeploymentTargetSchema),
    }),
    security: z.object({
      trustBoundaries: z.array(TrustBoundarySchema),
      findings: z.array(AffectingRecordSchema),
    }),
    quality: z.object({ risks: z.array(AffectingRecordSchema) }),
    evidence: z.array(EvidenceSchema),
    claims: z.array(ClaimSchema),
  })
  .superRefine(validateReferences)
  .transform((facts) => {
    // Keep only the evidence that a node in the network cites.
    const cited = new Set(
      [
        ...facts.architecture.components,
        ...facts.architecture.externalSystems,
        ...facts.data.stores,
        ...facts.code.symbols,
      ].flatMap((record) => record.grounding.evidenceIds),
    );
    return {
      ...facts,
      evidence: facts.evidence.filter((record) => cited.has(record.id)),
    };
  });

export function parseNetworkFacts(value) {
  return NetworkFactsSchema.parse(value);
}

/** Validate links before rendering; buildNetwork must never silently drop bad IDs. */
function validateReferences(facts, ctx) {
  const issue = (path, message) => ctx.addIssue({ code: "custom", path, message });
  const components = facts.architecture.components;
  const architecture = [...components, ...facts.architecture.externalSystems, ...facts.data.stores];
  const nodes = [...architecture, ...facts.code.symbols];
  const unique = (records, label) => {
    const ids = new Set();
    for (const r of records) {
      if (ids.has(r.id)) issue([label], `Duplicate id: ${r.id}`);
      ids.add(r.id);
    }
    return ids;
  };
  unique(nodes, "nodes");
  const evidenceIds = unique(facts.evidence, "evidence");
  const entityIds = new Set(architecture.map((r) => r.id));
  const componentIds = new Set(components.map((r) => r.id));
  const symbols = new Map(facts.code.symbols.map((r) => [r.id, r]));
  const surfaces = unique(facts.interfaces.apiSurfaces, "interfaces.apiSurfaces");
  const refs = (ids, known, field) => {
    for (const id of ids) if (!known.has(id)) issue([field], `Unresolved reference: ${id}`);
  };
  for (const node of nodes) {
    refs(node.grounding.evidenceIds, evidenceIds, `${node.id}.grounding.evidenceIds`);
    if (node.grounding.basis === "observed" && !node.grounding.evidenceIds.length) {
      issue([node.id, "grounding"], "Observed nodes require evidence");
    }
  }
  for (const c of components) refs(c.publicInterfaceIds, surfaces, `${c.id}.publicInterfaceIds`);
  for (const r of facts.architecture.relationships) refs([r.sourceId, r.targetId], entityIds, "relationships");
  for (const r of facts.data.stores) refs(r.accessEntityIds, entityIds, "stores.accessEntityIds");
  for (const r of facts.interfaces.dataContracts) refs([...r.producerEntityIds, ...r.consumerEntityIds], entityIds, "dataContracts");
  for (const r of facts.interfaces.apiSurfaces) refs(r.consumerEntityIds, entityIds, "apiSurfaces");
  for (const r of facts.security.trustBoundaries) refs([...r.sourceEntityIds, ...r.targetEntityIds], entityIds, "trustBoundaries");
  for (const r of [...facts.security.findings, ...facts.quality.risks]) refs(r.affectedEntityIds, entityIds, "affectedEntityIds");
  for (const r of facts.dependencies) refs(r.usedByEntityIds, entityIds, "usedByEntityIds");
  for (const r of facts.operations.configurationKeys) refs(r.consumerEntityIds, entityIds, "configurationKeys");
  for (const r of facts.delivery.deploymentTargets) refs(r.deployedEntityIds, entityIds, "deploymentTargets");
  for (const r of facts.claims) refs(r.relatedEntityIds, entityIds, "claims");
  for (const s of facts.code.symbols) if (s.componentId) refs([s.componentId], componentIds, `${s.id}.componentId`);
  if (!facts.code.extraction.performed && (facts.code.symbols.length || facts.code.calls.length)) {
    issue(["code", "extraction"], "Symbols/calls require extraction.performed");
  }
  for (const call of facts.code.calls) {
    refs([call.callerSymbolId, call.calleeSymbolId], symbols, "code.calls");
    const a = symbols.get(call.callerSymbolId)?.componentId;
    const b = symbols.get(call.calleeSymbolId)?.componentId;
    if (call.crossesComponent !== Boolean(a && b && a !== b)) {
      issue(["code", "calls"], "crossesComponent disagrees with symbol ownership");
    }
  }
  for (const e of facts.evidence) {
    if (e.lineStart !== null && e.lineEnd !== null && e.lineEnd < e.lineStart) issue(["evidence", e.id], "Invalid line range");
  }
}
