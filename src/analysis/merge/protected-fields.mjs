/**
 * Protected-field ownership and enforcement.
 *
 * The scanner owns what it measured; the model owns interpretation. This module is the
 * boundary between them, and it is deliberately an allowlist: it names the few fields a
 * model MAY contribute to each static record kind, and everything else is protected.
 *
 * A denylist would be the natural way to write this and the wrong one. Every field the
 * scanner gains later would default to writable, and the failure is silent - a model
 * quietly overwriting a measured hash or line number looks exactly like a correct run.
 * Inverted, a new scanner field defaults to protected and the worst case is a rejected
 * annotation that a person then allows on purpose.
 *
 * Enforcement is "absent", not "unchanged" (plan §24.3). A model that submits a
 * protected field is rejected even when the value it submits happens to match, because
 * a correct value proves nothing about the next run and accepting it would mean
 * comparing model output against static facts on every field forever.
 */
import { ID_PATTERN } from "../stable-ids.mjs";

export const OWNERSHIP_VERSION = "1.0.0";

/**
 * What a model may add, by static record kind. Derived from the responsibility table in
 * plan §11: the "LLM responsibility" column, and nothing from the scanner column.
 */
export const SEMANTIC_FIELDS = {
  "inventory.files": ["purpose", "summary", "audience", "topics", "importance", "componentId"],
  "code.symbols": ["summary", "responsibility", "componentId"],
  "code.calls": ["significance"],
  "detections.technologies": ["purpose", "scope"],
  "detections.dependencies": ["purpose", "affectedComponentIds", "fallbackBehavior"],
  "detections.entrypoints": ["purpose", "trigger", "componentId"],
  "detections.apiSurfaces": ["purpose", "consumers", "stability"],
  "detections.routes": ["purpose", "authSemantics", "errorSemantics", "consumers", "componentId"],
  "detections.dataContracts": ["purpose", "ownerComponentId"],
  "detections.dataStores": ["purpose", "ownership", "lifecycle", "retention", "consistency"],
  "detections.dataEntities": ["purpose", "ownership", "sensitivity", "lifecycle"],
  "detections.migrations": ["purpose", "risk"],
  "detections.prerequisites": ["purpose", "setupOrder", "troubleshooting"],
  "detections.commands": ["purpose", "sideEffects", "setupOrder", "troubleshooting"],
  "detections.configurationSources": ["purpose", "scope"],
  "detections.configurationKeys": ["purpose", "impact"],
  "detections.testSuites": ["scope", "isolation", "coverageSignals", "coverageGaps"],
  "detections.buildArtifacts": ["purpose", "consumers"],
  "detections.workflows": ["releaseMeaning", "rollbackBehavior", "observability"],
  "detections.deploymentTargets": ["purpose", "environment"],
  "detections.observability": ["purpose", "scope"],
  "detections.externalSystems": ["purpose", "trustLevel", "failureMode"],
};

/**
 * Evidence is created by the scanner or materialized from the frozen cache. A model may
 * cite an evidence id and may never annotate an evidence record, so it has no entry
 * above - listing it with an empty array would read as an oversight.
 */
export const UNANNOTATABLE_KINDS = new Set(["evidence", "repository", "inspection", "scanner"]);

/** Prose must not leak the host or the private source cache (plan §24.3). */
const HOST_PATH = /(^|[\s"'(])(\/[A-Za-z0-9._-]+){2,}|[A-Za-z]:[\\/]|file:\/\//;
const SOURCE_CACHE_ID = /\bchunk\.[0-9a-f]{8,}\b/;

export function semanticFieldsFor(kind) {
  return SEMANTIC_FIELDS[kind] ?? null;
}

/**
 * The protected-field snapshot: every static record addressable by id, with the exact
 * values the assembler will defend. Taken once, before any model runs.
 */
export function buildProtectedSnapshot(document) {
  const records = new Map();
  const add = (kind, record, id) => records.set(id, { kind, id, protected: Object.freeze({ ...record }) });

  for (const file of document.inventory.files) add("inventory.files", file, file.path);
  for (const symbol of document.code.symbols) add("code.symbols", symbol, symbol.id);
  for (const call of document.code.calls) add("code.calls", call, call.id);
  for (const [collection, items] of Object.entries(document.detections)) {
    for (const item of items) add(`detections.${collection}`, item, item.id);
  }
  for (const record of document.evidence) add("evidence", record, record.id);

  return {
    ownershipVersion: OWNERSHIP_VERSION,
    artifactId: document.artifactId,
    treeFingerprint: document.repository.treeFingerprint,
    records,
    evidenceIds: new Set(document.evidence.map((e) => e.id)),
  };
}

class Violations {
  constructor() { this.items = []; }
  add(code, message, detail = {}) { this.items.push({ code, message, ...detail }); }
  get ok() { return this.items.length === 0; }
}

/**
 * Check one slice's annotations against the snapshot.
 *
 * Returns every violation rather than throwing on the first, so a rejected slice can be
 * reported back to a provider in one round trip instead of one failure at a time.
 */
export function validateAnnotations(slice, snapshot) {
  const v = new Violations();

  if (slice.artifactId !== snapshot.artifactId) {
    v.add("artifact-mismatch", "slice analyzed a different static artifact",
      { expected: snapshot.artifactId, received: slice.artifactId ?? null });
  }
  if (slice.treeFingerprint !== snapshot.treeFingerprint) {
    v.add("fingerprint-mismatch", "slice analyzed a different repository tree",
      { expected: snapshot.treeFingerprint, received: slice.treeFingerprint ?? null });
  }

  for (const [index, annotation] of (slice.annotations ?? []).entries()) {
    const where = `annotations[${index}]`;
    const entry = snapshot.records.get(annotation.targetId);

    if (!entry) {
      v.add("unknown-target", `${where} annotates a record that is not in this run`,
        { targetId: annotation.targetId ?? null });
      continue;
    }
    if (UNANNOTATABLE_KINDS.has(entry.kind)) {
      v.add("unannotatable-kind", `${where} targets ${entry.kind}, which a model may only cite`,
        { targetId: annotation.targetId, kind: entry.kind });
      continue;
    }

    const allowed = semanticFieldsFor(entry.kind);
    if (!allowed) {
      v.add("unknown-kind", `${where} targets a kind with no ownership rule`,
        { targetId: annotation.targetId, kind: entry.kind });
      continue;
    }

    const fields = annotation.fields ?? {};
    for (const key of Object.keys(fields)) {
      if (Object.hasOwn(entry.protected, key)) {
        v.add("protected-field", `${where} sets ${key}, which the scanner owns`,
          { targetId: annotation.targetId, field: key, kind: entry.kind });
      } else if (!allowed.includes(key)) {
        v.add("unknown-field", `${where} sets ${key}, which is not a semantic field for ${entry.kind}`,
          { targetId: annotation.targetId, field: key, kind: entry.kind, allowed });
      }
    }

    if (annotation.basis === "observed") {
      const ids = annotation.evidenceIds ?? [];
      if (!ids.length) {
        v.add("observed-without-evidence", `${where} claims observed basis with no evidence`,
          { targetId: annotation.targetId });
      }
      for (const id of ids) {
        if (!snapshot.evidenceIds.has(id)) {
          v.add("unresolved-evidence", `${where} cites evidence that is not in this run`,
            { targetId: annotation.targetId, evidenceId: id });
        }
      }
    } else if (annotation.basis !== "inferred" && annotation.basis !== "documented") {
      v.add("bad-basis", `${where} has basis ${annotation.basis ?? "(missing)"}`,
        { targetId: annotation.targetId, basis: annotation.basis ?? null });
    }

    if (annotation.verificationStatus && annotation.verificationStatus !== "not-checked") {
      v.add("premature-verification", `${where} sets verificationStatus before verification`,
        { targetId: annotation.targetId, verificationStatus: annotation.verificationStatus });
    }

    for (const [key, value] of Object.entries(fields)) {
      if (typeof value !== "string") continue;
      if (HOST_PATH.test(value)) {
        v.add("host-path-in-prose", `${where}.${key} contains a host-absolute path`,
          { targetId: annotation.targetId, field: key });
      }
      if (SOURCE_CACHE_ID.test(value)) {
        v.add("cache-id-in-prose", `${where}.${key} leaks a source-cache identifier`,
          { targetId: annotation.targetId, field: key });
      }
    }
  }

  for (const [index, entity] of (slice.entities ?? []).entries()) {
    const where = `entities[${index}]`;
    if (typeof entity.id !== "string" || !ID_PATTERN.test(entity.id)) {
      v.add("bad-entity-id", `${where} has an id that is not stable-ID compliant`, { id: entity.id ?? null });
    } else if (snapshot.records.has(entity.id)) {
      v.add("entity-id-collision", `${where} reuses a static record id`, { id: entity.id });
    }
  }

  return { valid: v.ok, violations: v.items };
}

/**
 * Join validated annotations onto static cores.
 *
 * The static record is spread first and the semantic fields are attached under their own
 * key rather than merged in beside them. Two reasons: a protected value can never be
 * shadowed by a same-named semantic one even if the allowlist is later edited wrongly,
 * and the provenance of every field stays visible in the output.
 */
export function mergeAnnotations(document, slices, snapshot) {
  const byTarget = new Map();
  for (const slice of slices) {
    for (const annotation of slice.annotations ?? []) {
      if (!byTarget.has(annotation.targetId)) byTarget.set(annotation.targetId, []);
      byTarget.get(annotation.targetId).push({ ...annotation, sliceId: slice.sliceId });
    }
  }

  const conflicts = [];
  const merged = new Map();
  for (const [targetId, annotations] of byTarget) {
    const entry = snapshot.records.get(targetId);
    const fields = {};
    const provenance = {};
    for (const annotation of annotations) {
      for (const [key, value] of Object.entries(annotation.fields ?? {})) {
        if (Object.hasOwn(fields, key) && JSON.stringify(fields[key]) !== JSON.stringify(value)) {
          // Two slices disagreed. Recorded, never silently resolved by ordering.
          conflicts.push({
            targetId, field: key,
            values: [
              { sliceId: provenance[key].sliceId, value: fields[key] },
              { sliceId: annotation.sliceId, value },
            ],
          });
          continue;
        }
        fields[key] = value;
        provenance[key] = {
          sliceId: annotation.sliceId, basis: annotation.basis,
          evidenceIds: annotation.evidenceIds ?? [],
        };
      }
    }
    merged.set(targetId, {
      ...entry.protected,
      semantic: Object.keys(fields).length ? fields : null,
      semanticProvenance: Object.keys(provenance).length ? provenance : null,
    });
  }

  return { merged, conflicts };
}
