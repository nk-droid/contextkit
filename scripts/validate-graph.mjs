#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const graphKinds = new Set(["architecture", "runtime-flow", "imports", "deployment"]);
const nodeKinds = new Set([
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
]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function safeRelativePath(value) {
  return (
    text(value) &&
    !isAbsolute(value) &&
    !/^[a-zA-Z]:[\\/]/.test(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

export function validateGraphDocument(document, repositoryRoot) {
  const errors = [];
  const add = (path, message) => errors.push(`${path}: ${message}`);

  if (!object(document)) return ["$: expected an object"];
  if (document.schemaVersion !== 1) add("schemaVersion", "expected 1");
  if (!object(document.repository)) {
    add("repository", "expected an object");
  } else {
    for (const field of ["id", "name", "source"]) {
      if (!text(document.repository[field])) add(`repository.${field}`, "expected a non-empty string");
    }
    if (
      document.repository.revision !== undefined &&
      document.repository.revision !== null &&
      !text(document.repository.revision)
    ) {
      add("repository.revision", "expected a non-empty string or null");
    }
  }

  if (!Array.isArray(document.graphs) || document.graphs.length === 0) {
    add("graphs", "expected at least one graph");
    return errors;
  }

  const graphIds = new Set();
  document.graphs.forEach((graph, graphIndex) => {
    const base = `graphs[${graphIndex}]`;
    if (!object(graph)) {
      add(base, "expected an object");
      return;
    }
    if (!text(graph.id)) add(`${base}.id`, "expected a non-empty string");
    else if (graphIds.has(graph.id)) add(`${base}.id`, `duplicate graph id ${graph.id}`);
    else graphIds.add(graph.id);
    if (!graphKinds.has(graph.kind)) add(`${base}.kind`, "unsupported graph kind");
    if (!text(graph.title)) add(`${base}.title`, "expected a non-empty string");
    if (!text(graph.description)) add(`${base}.description`, "expected a non-empty string");
    if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
      add(`${base}.nodes`, "expected at least one node");
      return;
    }
    if (graph.nodes.length > 300) add(`${base}.nodes`, "exceeds the 300 node limit");
    if (!Array.isArray(graph.edges)) add(`${base}.edges`, "expected an array");
    else if (graph.edges.length > 1000) add(`${base}.edges`, "exceeds the 1000 edge limit");

    const nodeIds = new Set();
    graph.nodes.forEach((node, nodeIndex) => {
      const nodePath = `${base}.nodes[${nodeIndex}]`;
      if (!object(node)) {
        add(nodePath, "expected an object");
        return;
      }
      if (!text(node.id)) add(`${nodePath}.id`, "expected a non-empty string");
      else if (nodeIds.has(node.id)) add(`${nodePath}.id`, `duplicate node id ${node.id}`);
      else nodeIds.add(node.id);
      if (!text(node.label)) add(`${nodePath}.label`, "expected a non-empty string");
      if (!nodeKinds.has(node.kind)) add(`${nodePath}.kind`, "unsupported node kind");
      if (!text(node.summary)) add(`${nodePath}.summary`, "expected a non-empty string");
      if (!new Set(["observed", "inferred"]).has(node.basis)) add(`${nodePath}.basis`, "expected observed or inferred");
      validateEvidence(node, nodePath, repositoryRoot, add);
    });

    if (!Array.isArray(graph.edges)) return;
    const edgeIds = new Set();
    graph.edges.forEach((edge, edgeIndex) => {
      const edgePath = `${base}.edges[${edgeIndex}]`;
      if (!object(edge)) {
        add(edgePath, "expected an object");
        return;
      }
      if (!text(edge.id)) add(`${edgePath}.id`, "expected a non-empty string");
      else if (edgeIds.has(edge.id)) add(`${edgePath}.id`, `duplicate edge id ${edge.id}`);
      else edgeIds.add(edge.id);
      for (const field of ["source", "target", "kind", "label"]) {
        if (!text(edge[field])) add(`${edgePath}.${field}`, "expected a non-empty string");
      }
      if (text(edge.source) && !nodeIds.has(edge.source)) add(`${edgePath}.source`, `unknown node ${edge.source}`);
      if (text(edge.target) && !nodeIds.has(edge.target)) add(`${edgePath}.target`, `unknown node ${edge.target}`);
      if (!new Set(["observed", "inferred"]).has(edge.basis)) add(`${edgePath}.basis`, "expected observed or inferred");
      validateEvidence(edge, edgePath, repositoryRoot, add);
    });
  });

  return errors;
}

function validateEvidence(item, itemPath, repositoryRoot, add) {
  if (item.path !== undefined) validatePath(item.path, `${itemPath}.path`, repositoryRoot, add);
  if (!Array.isArray(item.evidence)) {
    if (item.basis === "observed") add(`${itemPath}.evidence`, "observed items require evidence");
    else if (item.evidence !== undefined) add(`${itemPath}.evidence`, "expected an array");
    return;
  }
  if (item.basis === "observed" && item.evidence.length === 0) {
    add(`${itemPath}.evidence`, "observed items require evidence");
  }
  item.evidence.forEach((evidence, index) => {
    const evidencePath = `${itemPath}.evidence[${index}]`;
    if (!object(evidence)) {
      add(evidencePath, "expected an object");
      return;
    }
    validatePath(evidence.path, `${evidencePath}.path`, repositoryRoot, add);
    if (evidence.detail !== undefined && !text(evidence.detail)) add(`${evidencePath}.detail`, "expected a non-empty string");
  });
}

function validatePath(value, fieldPath, repositoryRoot, add) {
  if (!safeRelativePath(value)) {
    add(fieldPath, "expected a safe repository-relative path");
    return;
  }
  if (!repositoryRoot) return;
  const root = resolve(repositoryRoot);
  const candidate = resolve(root, value);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    add(fieldPath, "path escapes the repository root");
  } else if (!existsSync(candidate)) {
    add(fieldPath, `path does not exist: ${value}`);
  }
}

function main() {
  const [file, repositoryRoot] = process.argv.slice(2);
  if (!file) {
    console.error("Usage: node scripts/validate-graph.mjs <graph.json> [repository-root]");
    process.exitCode = 2;
    return;
  }
  let document;
  try {
    document = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Invalid JSON: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return;
  }
  const errors = validateGraphDocument(document, repositoryRoot);
  if (errors.length) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Valid repository graph: ${file}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
