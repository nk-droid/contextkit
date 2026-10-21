import fs from "node:fs";
import { createHash } from "node:crypto";
import { checkRunBinding, freezeEntityRegistry } from "./foundation.mjs";
import { validateSliceResult } from "./slice-kit.mjs";
import { checkRequestedEvidence } from "../validation/requested-evidence.mjs";

export const resultHash = (result) => createHash("sha256").update(JSON.stringify(result)).digest("hex");

export function checkCachedSlice(envelope, slice, ctx, { foundationHash = null } = {}) {
  let idMappings = [];
  const errors = [...checkRunBinding(envelope, ctx.snapshot).errors];
  if (envelope?.boundTo?.contractVersion !== slice.contractVersion
    || envelope?.boundTo?.schemaHash !== slice.schemaHash()
    || envelope?.boundTo?.promptSetVersion !== slice.promptSetVersion) {
    errors.push({ code: "stale-contract", message: `${slice.id}: schema changed; rerun this slice` });
  }
  if (slice.dependsOn.length && envelope?.boundTo?.foundationHash !== foundationHash) {
    errors.push({ code: "stale-foundation", message: `${slice.id}: foundation changed; rerun this slice` });
  }
  if (!errors.length) {
    const added = checkRequestedEvidence(envelope, ctx.store);
    errors.push(...added.errors);
    if (!errors.length) {
      const validated = validateSliceResult(envelope.result, slice, {
        ...ctx, snapshot: { ...ctx.snapshot, evidenceIds: new Set([...ctx.snapshot.evidenceIds, ...added.records.map((e) => e.id)]) },
      });
      errors.push(...validated.errors);
      idMappings = validated.idMappings ?? [];
    }
  }
  return { valid: !errors.length, errors, idMappings };
}

export function readFoundation(workspace, slice, provider, ctx) {
  const file = workspace.slicePath(slice.order, slice.id, provider, "response");
  if (!fs.existsSync(file)) throw new Error(`Run foundation first with --provider ${provider}`);
  const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  const check = checkCachedSlice(envelope, slice, ctx);
  if (!check.valid) throw new Error(check.errors.map((e) => e.message).join("; "));
  return {
    envelope, foundationHash: resultHash(envelope.result),
    registry: freezeEntityRegistry(envelope.result, { snapshot: ctx.snapshot }),
  };
}
