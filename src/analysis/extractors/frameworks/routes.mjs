/**
 * Route detectors.
 *
 * Turns exact syntax into typed route candidates. Each record states what the source
 * *declares*, never what it means: "no recognized auth middleware in this file" is an
 * observation the scanner can make; "this route is publicly unauthenticated" is a
 * semantic conclusion needing wider evidence, and is not made here.
 */
import path from "node:path";
import { detectionId } from "../../stable-ids.mjs";
import { ExtractorRun } from "../extractor.mjs";
import { buildCodeMask, lineAt, matchesInCode } from "../source-text.mjs";

const VERSION = "1.0.0";
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Next / Vinext file-system routing: an exported HTTP verb in a route module. */
function nextRoutes(ctx, symbols, run) {
  const routes = [];
  for (const symbol of symbols) {
    if (!HTTP_METHODS.includes(symbol.name)) continue;
    if (!/(^|\/)(route|page)\.(ts|tsx|js|jsx|mjs)$/.test(symbol.path)) continue;
    run.consider();
    // app/api/repositories/route.ts -> /api/repositories
    const urlPath = "/" + symbol.path
      .replace(/^(src\/)?(web\/)?app\//, "")
      .replace(/\/(route|page)\.(ts|tsx|js|jsx|mjs)$/, "")
      .replace(/\[\.\.\.([^\]]+)\]/g, ":$1*")
      .replace(/\[([^\]]+)\]/g, ":$1");
    routes.push({
      id: detectionId("route", symbol.path, symbol.name),
      detector: run.name, confidence: "high", evidenceIds: symbol.evidenceIds ?? [],
      framework: "next-app-router",
      method: symbol.name,
      pathOrName: urlPath === "/" ? "/" : urlPath.replace(/\/$/, ""),
      implementationPath: symbol.path,
      implementationSymbol: symbol.name,
      lineStart: symbol.lineStart,
      // Exact observation only. Absence here does not establish that the route is open.
      recognizedAuthMiddlewareInFile: false,
    });
    run.emitted();
  }
  return routes;
}

/** Decorator-based Python routing: FastAPI, Flask, and APIRouter share the shape. */
function pythonDecoratorRoutes(ctx, symbols, run) {
  const routes = [];
  for (const symbol of symbols) {
    if (symbol.language !== "Python" || !symbol.decorators?.length) continue;
    for (const decorator of symbol.decorators) {
      const match = /^(?:([A-Za-z_][\w.]*)\.)?(get|post|put|patch|delete|head|options|route)$/i.exec(decorator);
      if (!match) continue;
      run.consider();
      const text = ctx.contents.get(symbol.path) ?? "";
      // Decorators stack, so the route decorator is not reliably the line directly
      // above the declaration. Walk the contiguous decorator block and take the
      // literal from the line that carries *this* decorator.
      const lines = text.split("\n");
      let decoratorLine = "";
      for (let i = symbol.lineStart - 2; i >= 0 && i >= symbol.lineStart - 12; i -= 1) {
        const candidate = lines[i] ?? "";
        if (candidate.includes("@" + decorator) || new RegExp("@\\S*\\b" + match[2] + "\\s*\\(", "i").test(candidate)) {
          decoratorLine = candidate;
          break;
        }
        if (candidate.trim() && !candidate.trim().startsWith("@") && !/^[\s)\]]/.test(candidate)) break;
      }
      const pathLiteral = /["']([^"']*)["']/.exec(decoratorLine);
      routes.push({
        id: detectionId("route", symbol.path, symbol.name),
        detector: run.name, confidence: pathLiteral ? "high" : "medium",
        evidenceIds: symbol.evidenceIds ?? [],
        framework: /router/i.test(match[1] ?? "") ? "python-apirouter" : "python-decorator",
        method: match[2].toUpperCase() === "ROUTE" ? null : match[2].toUpperCase(),
        pathOrName: pathLiteral ? pathLiteral[1] : null,
        implementationPath: symbol.path,
        implementationSymbol: symbol.name,
        lineStart: symbol.lineStart,
        decorator,
        recognizedAuthMiddlewareInFile: /\b(Depends|require_auth|authenticate|verify_token)\b/.test(text),
      });
      run.emitted();
      break;
    }
  }
  return routes;
}

/**
 * Express-style registration: an `app.get("/path", handler)` call in executable code.
 *
 * Matches beginning inside a comment or a string literal are skipped - without that,
 * this detector reports the example in the line above as a route.
 */
function expressRoutes(ctx, run) {
  const routes = [];
  for (const [relPath, text] of ctx.contents) {
    if (![".ts", ".js", ".mjs", ".tsx"].includes(path.extname(relPath))) continue;
    const mask = buildCodeMask(text, relPath);
    const pattern = /\b(?:app|router)\.(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/g;
    for (const match of matchesInCode(text, pattern, mask)) {
      run.consider();
      const line = lineAt(text, match.index);
      const evId = ctx.evidence.add({
        path: relPath, lineStart: line, lineEnd: line,
        detail: `registers the ${match[1].toUpperCase()} route ${match[2]}`,
        sourceText: text, region: `route-${match[1]}-${match[2]}`,
      });
      routes.push({
        id: detectionId("route", relPath, `${match[1]}-${match[2]}`),
        detector: run.name,
        // Syntax-derived rather than resolved through the type system.
        confidence: "medium",
        evidenceIds: [evId].filter(Boolean),
        framework: "express-style",
        method: match[1].toUpperCase(),
        pathOrName: match[2],
        implementationPath: relPath,
        implementationSymbol: null,
        lineStart: line,
        recognizedAuthMiddlewareInFile: /\b(authenticate|requireAuth|passport|verifyToken)\b/.test(text),
      });
      run.emitted();
    }
  }
  return routes;
}

export function detectRoutes(ctx, symbols) {
  const run = new ExtractorRun({
    name: "framework.routes", version: VERSION, exactness: "mixed",
    supports: ["next-app-router", "fastapi", "flask", "express"],
  });
  const routes = [
    ...nextRoutes(ctx, symbols, run),
    ...pythonDecoratorRoutes(ctx, symbols, run),
    ...expressRoutes(ctx, run),
  ];
  const seen = new Set();
  const unique = routes.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  // Group routes into one API surface per declaring directory.
  const surfaces = new Map();
  for (const route of unique) {
    const key = path.dirname(route.implementationPath);
    if (!surfaces.has(key)) {
      surfaces.set(key, {
        id: detectionId("api", key),
        detector: run.name, confidence: "medium", evidenceIds: [],
        name: key === "." ? "root" : key,
        kind: "http",
        basePathOrNamespace: key,
        routeIds: [],
      });
    }
    const surface = surfaces.get(key);
    surface.routeIds.push(route.id);
    surface.evidenceIds.push(...route.evidenceIds);
  }

  return {
    apiSurfaces: [...surfaces.values()]
      .map((s) => ({ ...s, evidenceIds: [...new Set(s.evidenceIds)] }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    routes: unique,
    provenance: run.finish(),
  };
}
