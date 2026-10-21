/**
 * Which slice produces which part of the final document (plan §9).
 *
 * This is the map the whole pipeline turns on. A section named here is asked for by
 * exactly one slice, so assembly never has to choose between two producers, and a
 * section named by no slice is a visible hole rather than a silently empty array.
 *
 * Ordering follows dependency: a slice may only reference entities an earlier slice
 * froze, so the sections that establish identity come first.
 */

export const OWNERSHIP = Object.freeze({
  foundation: [
    // Identity and structure. Everything later refers back to these ids.
    { section: "project", array: "primaryUsers" },
    { section: "project", array: "capabilities" },
    { section: "project", array: "nonGoals" },
    { section: "project", array: "repositoryRoles" },
    { section: "architecture", array: "components" },
    { section: "architecture", array: "externalSystems" },
    { section: "architecture", array: "styles" },
  ],

  "behavior-data": [
    // How it behaves and what it does with data.
    { section: "architecture", array: "relationships" },
    { section: "architecture", array: "runtimeFlows" },
    { section: "architecture", array: "boundaries" },
    { section: "architecture", array: "invariants" },
    { section: "interfaces", array: "apiSurfaces" },
    { section: "interfaces", array: "dataContracts" },
    { section: "data", array: "stores" },
    { section: "data", array: "entities" },
    { section: "data", array: "retentionRules" },
    { section: "data", array: "consistencyRules" },
  ],

  // Declared now so the gaps are visible before the slices exist. Phase 7 fills these.
  "operations-delivery": [
    { section: "operations", array: "prerequisites" },
    { section: "operations", array: "setupSteps" },
    { section: "operations", array: "commands" },
    { section: "operations", array: "configurationSources" },
    { section: "operations", array: "configurationKeys" },
    { section: "operations", array: "troubleshooting" },
    { section: "operations", array: "localServices" },
    { section: "testing", array: "suites" },
    { section: "testing", array: "coverageSignals" },
    { section: "testing", array: "gaps" },
    { section: "delivery", array: "workflows" },
    { section: "delivery", array: "deploymentTargets" },
    { section: "delivery", array: "buildArtifacts" },
    { section: "delivery", array: "releaseProcess" },
    { section: "delivery", array: "observability" },
    { section: "testing", array: "fixturesAndFakes" },
  ],

  assurance: [
    { section: "security", array: "findings" },
    { section: "security", array: "authentication" },
    { section: "security", array: "authorization" },
    { section: "security", array: "secretHandling" },
    { section: "security", array: "sensitiveData" },
    { section: "security", array: "supplyChain" },
    { section: "quality", array: "designDecisions" },
    { section: "security", array: "trustBoundaries" },
    { section: "security", array: "controls" },
    { section: "quality", array: "strengths" },
    { section: "quality", array: "limitations" },
    { section: "quality", array: "risks" },
    { section: "quality", array: "technicalDebt" },
    { section: "quality", array: "unknowns" },
    { section: "quality", array: "contradictions" },
  ],

  guidance: [
    { section: "guidance", array: "readingOrder" },
    { section: "guidance", array: "safeFirstChanges" },
    { section: "guidance", array: "changeRecipes" },
    { section: "guidance", array: "reviewHotspots" },
    { section: "guidance", array: "agentRules" },
    { section: "guidance", array: "coupledPaths" },
    { section: "guidance", array: "responseGuidance" },
  ],
});

/**
 * Sections of the final document that no slice claims.
 *
 * Called by a test rather than at runtime: an unclaimed section is a design gap to
 * notice during development, not an error to raise during a run.
 */
export function unclaimedArrays(finalSchema) {
  const defs = finalSchema.$defs ?? finalSchema.definitions ?? {};
  const deref = (n) => (n && n.$ref ? defs[n.$ref.split("/").pop()] ?? {} : n);
  const claimed = new Set(
    Object.values(OWNERSHIP).flat().map(({ section, array }) => `${section}.${array}`));

  // Sections the scanner owns outright, or the assembler computes; not slice work.
  const notSliceWork = new Set(["inventory", "code", "repository", "inspection", "evidence", "generator"]);

  const missing = [];
  for (const [section, node] of Object.entries(finalSchema.properties)) {
    if (notSliceWork.has(section)) continue;
    const sectionSchema = deref(node);
    for (const [array, value] of Object.entries(sectionSchema.properties ?? {})) {
      if (deref(value).type !== "array") continue;
      const key = `${section}.${array}`;
      if (!claimed.has(key) && !SCANNER_DERIVED.has(key)) missing.push(key);
    }
  }
  return missing;
}

/**
 * Arrays built from scanner detections plus annotations, not produced wholesale by a
 * slice. The assembler fills these by joining static records with the enrichment
 * annotations slices attach to them, so "no slice claims it" is correct here rather
 * than a gap.
 */
export const SCANNER_DERIVED = Object.freeze(new Set([
  "technologies.records",
  "technologies.primaryRuntimeIds",
  "technologies.primaryLanguageIds",
  "technologies.packageManagerIds",
  "technologies.buildToolIds",
  "interfaces.entrypoints",
  "data.migrations",
  "testing.frameworkIds",
]));

export function ownedBy(sliceId) {
  return OWNERSHIP[sliceId] ?? [];
}
