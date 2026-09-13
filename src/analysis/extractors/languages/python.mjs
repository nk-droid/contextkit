/**
 * Python adapter.
 *
 * Delegates parsing to a versioned AST adapter running under the host interpreter and
 * records which interpreter produced the result. Resolution grading happens here so
 * the resolved/heuristic/unresolved rules live in one place for every language.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ExtractorRun } from "../extractor.mjs";
import { symbolId } from "../../stable-ids.mjs";

const VERSION = "1.0.0";
const ADAPTER = fileURLToPath(new URL("./python_ast.py", import.meta.url));

function findInterpreter() {
  for (const candidate of [process.env.CONTEXTKIT_PYTHON, "python3", "python"]) {
    if (!candidate) continue;
    try {
      const version = execFileSync(candidate, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { command: candidate, version: version.trim() };
    } catch { /* try next */ }
  }
  return null;
}

export function extractPython(ctx) {
  const run = new ExtractorRun({
    name: "language.python", version: VERSION, exactness: "mixed", supports: [".py"],
  });

  const files = [...ctx.contents.keys()].filter((p) => path.extname(p) === ".py");
  if (!files.length) return { symbols: [], calls: [], imports: [], unresolvedCalls: 0, provenance: run.finish() };

  const interpreter = findInterpreter();
  if (!interpreter) {
    run.unavailable("No Python interpreter available; declarations were not extracted.");
    run.consider(files.length);
    return { symbols: [], calls: [], imports: [], unresolvedCalls: 0, provenance: run.finish() };
  }
  run.warn(`parsed with ${interpreter.version}`);
  run.consider(files.length);

  let parsed;
  try {
    const stdout = execFileSync(interpreter.command, [ADAPTER], {
      input: JSON.stringify({ root: ctx.root, files }),
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    parsed = JSON.parse(stdout);
  } catch (error) {
    run.unavailable(`Python AST adapter failed: ${String(error.message).slice(0, 200)}`);
    return { symbols: [], calls: [], imports: [], unresolvedCalls: 0, provenance: run.finish() };
  }
  for (const failure of parsed.parseFailures ?? []) run.fail(failure.path, failure.message);

  const symbols = [];
  const imports = [];
  const byModule = new Map();     // module dotted path -> Map(name -> id)
  const byName = new Map();
  const moduleOf = (rel) => rel.replace(/\.py$/, "").replace(/\//g, ".");

  for (const file of parsed.files ?? []) {
    run.parsed();
    const moduleName = moduleOf(file.path);
    byModule.set(moduleName, new Map());
    for (const sym of file.symbols) {
      const id = symbolId(file.path, sym.qualifiedName);
      if (symbols.some((s) => s.id === id)) continue;
      symbols.push({
        id, name: sym.name, qualifiedName: `${moduleName}.${sym.qualifiedName}`,
        kind: sym.kind, path: file.path,
        lineStart: sym.lineStart, lineEnd: sym.lineEnd,
        signature: sym.signature,
        docstringFirstLine: sym.docstringFirstLine || null,
        parentSymbolId: sym.className ? symbolId(file.path, sym.className) : null,
        exported: sym.exported,
        visibility: sym.name.startsWith("__") ? "private" : sym.name.startsWith("_") ? "internal" : "public",
        decorators: sym.decorators,
        isEntrypoint: sym.name === "main" || sym.decorators.some((d) =>
          /\b(get|post|put|patch|delete|route|remote|task|command|fixture)$/i.test(d)),
        language: "Python",
        detector: run.name,
      });
      byModule.get(moduleName).set(sym.name, id);
      if (!byName.has(sym.name)) byName.set(sym.name, []);
      byName.get(sym.name).push(id);
      run.emitted();
    }
    for (const imp of file.imports) {
      imports.push({ fromPath: file.path, specifier: imp.module, names: [imp.name],
        external: !byModule.has(imp.module), lineStart: imp.line });
    }
  }

  // Second pass: grade every call candidate the adapter reported.
  const calls = new Map();
  let unresolved = 0;
  for (const file of parsed.files ?? []) {
    const moduleName = moduleOf(file.path);
    const local = byModule.get(moduleName) ?? new Map();
    const importMap = new Map();
    for (const imp of file.imports) importMap.set(imp.asname || imp.name, imp.module);

    for (const call of file.calls) {
      const callerId = symbolId(file.path, call.caller);
      let calleeId = null;
      let resolution = null;
      if (local.has(call.callee)) {
        calleeId = local.get(call.callee); resolution = "resolved";
      } else if (importMap.has(call.callee)) {
        const target = byModule.get(importMap.get(call.callee))?.get(call.callee);
        if (target) { calleeId = target; resolution = "resolved"; }
      } else if (call.form === "attribute" && call.base && importMap.has(call.base)) {
        const target = byModule.get(importMap.get(call.base))?.get(call.callee);
        if (target) { calleeId = target; resolution = "resolved"; }
      }
      if (!calleeId && byName.get(call.callee)?.length === 1) {
        calleeId = byName.get(call.callee)[0]; resolution = "heuristic";
      }
      if (!calleeId) { unresolved += 1; continue; }
      if (calleeId === callerId) continue;
      const key = `${callerId}>${calleeId}`;
      const entry = calls.get(key) ?? { callerSymbolId: callerId, calleeSymbolId: calleeId, lines: [], resolution };
      entry.lines.push(call.line);
      if (resolution === "resolved") entry.resolution = "resolved";
      calls.set(key, entry);
    }
  }

  return {
    symbols, calls: [...calls.values()], imports,
    unresolvedCalls: unresolved,
    interpreter: interpreter.version,
    provenance: run.finish(),
  };
}
