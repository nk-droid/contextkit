/**
 * TypeScript and JavaScript adapter.
 *
 * Uses the TypeScript compiler API for declarations, imports, signatures, and exact
 * source locations. Regular expressions are not used for semantic extraction: a regex
 * cannot tell a call from a string containing one, and the plan requires that call
 * edges be attributable or explicitly unresolved.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ExtractorRun } from "../extractor.mjs";
import { symbolId } from "../../stable-ids.mjs";

const VERSION = "1.0.0";
const EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Resolve the compiler without making the web application's node_modules a hard
 * runtime dependency: prefer an explicit override, then the scanner's own install,
 * and only then fall back to the web workspace - recording which one was used.
 */
function loadTypeScript(_repoRoot, run) {
  const require = createRequire(import.meta.url);
  // Resolve from the scanner's own installation, never from the repository being
  // scanned - a target repo's node_modules is untrusted input, not a parser source.
  const scannerRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const candidates = [];
  if (process.env.CONTEXTKIT_TYPESCRIPT_PATH) candidates.push(process.env.CONTEXTKIT_TYPESCRIPT_PATH);
  candidates.push("typescript");
  candidates.push(path.join(scannerRoot, "node_modules", "typescript"));
  candidates.push(path.join(scannerRoot, "web", "node_modules", "typescript"));
  for (const candidate of candidates) {
    try {
      const ts = require(candidate);
      if (ts && ts.createSourceFile) {
        run.warn("typescript resolved from " + (candidate === "typescript" ? "scanner dependencies" : candidate));
        return ts;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function extractTypeScript(ctx) {
  const run = new ExtractorRun({
    name: "language.typescript", version: VERSION, exactness: "mixed",
    supports: [...EXTENSIONS],
  });
  const ts = loadTypeScript(ctx.root, run);
  if (!ts) {
    run.unavailable("TypeScript compiler API is not installed; declarations were not extracted.");
    return { symbols: [], calls: [], imports: [], unresolvedCalls: 0, provenance: run.finish() };
  }

  const symbols = [];
  const imports = [];
  const bodies = [];
  const byModule = new Map();   // relPath -> Map(name -> symbolId)
  const byName = new Map();     // bare name -> [symbolId]

  for (const [relPath, text] of ctx.contents) {
    if (!EXTENSIONS.has(path.extname(relPath))) continue;
    run.consider();
    let sf;
    try {
      sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true,
        relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : undefined);
    } catch (error) {
      run.fail(relPath, error.message);
      continue;
    }
    run.parsed();
    byModule.set(relPath, new Map());
    const lineAt = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

    const addSymbol = (name, kind, node, parentId = null, className = null) => {
      if (!name) return null;
      const qualified = className ? `${className}.${name}` : name;
      const id = symbolId(relPath, qualified);
      if (symbols.some((s) => s.id === id)) return id;
      const lineStart = lineAt(node.getStart(sf));
      const lineEnd = lineAt(node.getEnd());
      let signature = name;
      try {
        const params = (node.parameters ?? []).map((p) => p.name.getText(sf)).join(", ");
        signature = kind === "class" ? `class ${name}` : `${name}(${params})`;
      } catch { /* keep the bare name */ }
      const modifiers = ts.canHaveModifiers?.(node) ? (ts.getModifiers(node) ?? []) : (node.modifiers ?? []);
      const exported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      symbols.push({
        id, name, qualifiedName: `${relPath}:${qualified}`, kind,
        path: relPath, lineStart, lineEnd, signature,
        parentSymbolId: parentId, exported,
        visibility: name.startsWith("_") ? "internal" : exported ? "public" : "internal",
        decorators: [],
        isEntrypoint: /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|main|default)$/.test(name),
        language: "TypeScript",
        detector: run.name,
      });
      byModule.get(relPath).set(name, id);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(id);
      run.emitted();
      return id;
    };

    const moduleImports = new Map();
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const spec = statement.moduleSpecifier.text;
        const clause = statement.importClause;
        const names = [];
        if (clause?.name) names.push(clause.name.text);
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) bindings.elements.forEach((e) => names.push(e.name.text));
        if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
        names.forEach((n) => moduleImports.set(n, spec));
        imports.push({
          fromPath: relPath, specifier: spec, names,
          external: !spec.startsWith("."),
          lineStart: lineAt(statement.getStart(sf)),
        });
        continue;
      }
      if (ts.isClassDeclaration(statement) && statement.name) {
        const classId = addSymbol(statement.name.text, "class", statement);
        for (const member of statement.members) {
          if (ts.isMethodDeclaration(member) && member.name) {
            const mid = addSymbol(member.name.getText(sf), "method", member, classId, statement.name.text);
            if (mid) bodies.push({ id: mid, relPath, node: member, sf });
          }
        }
        continue;
      }
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const id = addSymbol(statement.name.text, "function", statement);
        if (id) bodies.push({ id, relPath, node: statement, sf });
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
          if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
            const id = addSymbol(decl.name.text, "function", statement);
            if (id) bodies.push({ id, relPath, node: decl.initializer, sf });
          }
        }
      }
    }
    ctx.moduleImports.set(relPath, moduleImports);
  }

  // Resolution is graded: exact when an import or local binding proves the target,
  // heuristic when only a unique name matches, otherwise counted and dropped.
  const resolveModule = (fromFile, spec) => {
    if (!spec.startsWith(".")) return null;
    const base = path.posix.join(path.posix.dirname(fromFile), spec);
    for (const ext of ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.tsx"]) {
      if (byModule.has(base + ext)) return base + ext;
    }
    return null;
  };

  const calls = new Map();
  let unresolved = 0;
  for (const { id: callerId, relPath, node, sf } of bodies) {
    const local = byModule.get(relPath) ?? new Map();
    const importsHere = ctx.moduleImports.get(relPath) ?? new Map();
    const walk = (n) => {
      if (ts.isCallExpression(n)) {
        const target = n.expression;
        let name = null;
        if (ts.isIdentifier(target)) name = target.text;
        else if (ts.isPropertyAccessExpression(target)) name = target.name.text;
        let calleeId = null;
        let resolution = null;
        if (name) {
          if (ts.isIdentifier(target) && local.has(name)) {
            calleeId = local.get(name); resolution = "resolved";
          } else if (importsHere.has(name)) {
            const mod = resolveModule(relPath, importsHere.get(name));
            const found = mod && byModule.get(mod)?.get(name);
            if (found) { calleeId = found; resolution = "resolved"; }
          }
          if (!calleeId && ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
            const mod = resolveModule(relPath, importsHere.get(target.expression.text) ?? "");
            const found = mod && byModule.get(mod)?.get(name);
            if (found) { calleeId = found; resolution = "resolved"; }
          }
          if (!calleeId && byName.get(name)?.length === 1) {
            calleeId = byName.get(name)[0]; resolution = "heuristic";
          }
        }
        if (!calleeId) unresolved += 1;
        else if (calleeId !== callerId) {
          const key = `${callerId}>${calleeId}`;
          const entry = calls.get(key) ?? { callerSymbolId: callerId, calleeSymbolId: calleeId, lines: [], resolution };
          entry.lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
          if (resolution === "resolved") entry.resolution = "resolved";
          calls.set(key, entry);
        }
      }
      n.forEachChild(walk);
    };
    node.forEachChild(walk);
  }

  return {
    symbols,
    calls: [...calls.values()],
    imports,
    unresolvedCalls: unresolved,
    provenance: run.finish(),
  };
}
