import { shortHash } from "../stable-ids.mjs";

// A semantic projection is a distinct record from the detection it interprets.
// Providers sometimes reuse the detection's ID. Rekey only matching record kinds;
// never rewrite scanner records, annotation targets, evidence, or arbitrary prose.
const projections = {
  apiSurfaces: ["apiSurfaces", "surface"],
  dataContracts: ["dataContracts", "contract"],
  stores: ["dataStores", "store"],
  entities: ["dataEntities", "entity"],
};

export function normalizeSliceIds(result, slice, store) {
  const mappings = [];
  if (slice.id !== "behavior-data" || !result || typeof result !== "object") return { result, mappings };
  const ids = new Map();
  for (const [array, [kind, prefix]] of Object.entries(projections)) {
    const detected = new Set((store.document.detections[kind] ?? []).map((r) => r.id));
    for (const record of Array.isArray(result[array]) ? result[array] : []) {
      if (!detected.has(record?.id) || ids.has(record.id)) continue;
      const to = `${prefix}.semantic.${shortHash(record.id, 20)}`;
      ids.set(record.id, to);
      mappings.push({ from: record.id, to, array });
    }
  }
  if (!mappings.length) return { result, mappings };
  function rewrite(value, key = "", inAnnotation = false) {
    if (Array.isArray(value)) return value.map((v) => rewrite(v, key, inAnnotation || key === "annotations"));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .map(([k, v]) => [k, rewrite(v, k, inAnnotation)]));
    if (typeof value === "string" && (key === "id" || /Ids?$/.test(key))
      && !(inAnnotation && key === "targetId")) return ids.get(value) ?? value;
    return value;
  }
  return { result: rewrite(result), mappings };
}
