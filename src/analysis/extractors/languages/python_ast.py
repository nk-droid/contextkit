"""Versioned Python AST adapter.

Reads a JSON job on stdin ({"root": str, "files": [str]}) and writes one JSON result
on stdout. Runs as a separate process so the scanner does not depend on the host
interpreter being importable, and so the interpreter version used is recorded.

Emits declarations, imports, and call candidates. It does not decide which calls are
resolved - the Node side owns resolution so the grading rules live in one place.
"""
import ast
import json
import os
import sys

ADAPTER_VERSION = "1.0.0"


def signature_of(node):
    try:
        args = []
        a = node.args
        for arg in list(getattr(a, "posonlyargs", [])) + list(a.args):
            args.append(arg.arg)
        if a.vararg:
            args.append("*" + a.vararg.arg)
        for arg in a.kwonlyargs:
            args.append(arg.arg)
        if a.kwarg:
            args.append("**" + a.kwarg.arg)
        return "%s(%s)" % (node.name, ", ".join(args))
    except Exception:
        return node.name


def decorators_of(node):
    names = []
    for dec in getattr(node, "decorator_list", []):
        current = dec.func if isinstance(dec, ast.Call) else dec
        parts = []
        while isinstance(current, ast.Attribute):
            parts.append(current.attr)
            current = current.value
        if isinstance(current, ast.Name):
            parts.append(current.id)
        if parts:
            names.append(".".join(reversed(parts)))
    return names


def main():
    job = json.load(sys.stdin)
    root = job["root"]
    results = {
        "adapterVersion": ADAPTER_VERSION,
        "interpreter": sys.version.split()[0],
        "files": [],
        "parseFailures": [],
    }

    for rel in job["files"]:
        full = os.path.join(root, rel)
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as handle:
                source = handle.read()
            tree = ast.parse(source)
        except SyntaxError as exc:
            results["parseFailures"].append({"path": rel, "message": str(exc)[:200]})
            continue
        except OSError as exc:
            results["parseFailures"].append({"path": rel, "message": str(exc)[:200]})
            continue

        symbols = []
        imports = []
        calls = []

        def add(node, kind, class_name=None):
            qualified = "%s.%s" % (class_name, node.name) if class_name else node.name
            decorators = decorators_of(node)
            symbols.append({
                "name": node.name,
                "qualifiedName": qualified,
                "kind": kind,
                "lineStart": node.lineno,
                "lineEnd": getattr(node, "end_lineno", node.lineno) or node.lineno,
                "signature": "class %s" % node.name if kind == "class" else signature_of(node),
                "docstringFirstLine": (ast.get_docstring(node) or "").strip().splitlines()[0]
                if ast.get_docstring(node) else "",
                "decorators": decorators,
                "className": class_name,
                "exported": not node.name.startswith("_"),
            })
            return qualified

        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                for alias in node.names:
                    imports.append({
                        "module": node.module,
                        "name": alias.name,
                        "asname": alias.asname,
                        "line": node.lineno,
                        "relative": bool(node.level),
                    })
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    imports.append({
                        "module": alias.name,
                        "name": alias.name.split(".")[0],
                        "asname": alias.asname,
                        "line": node.lineno,
                        "relative": False,
                    })

        def visit_body(body, class_name=None):
            for node in body:
                if isinstance(node, ast.ClassDef):
                    add(node, "class")
                    visit_body(node.body, node.name)
                elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    kind = "method" if class_name else "function"
                    if any(d.endswith("property") for d in decorators_of(node)):
                        kind = "property"
                    qualified = add(node, kind, class_name)
                    for sub in ast.walk(node):
                        if not isinstance(sub, ast.Call):
                            continue
                        target = sub.func
                        if isinstance(target, ast.Name):
                            calls.append({"caller": qualified, "callee": target.id,
                                          "line": sub.lineno, "form": "name"})
                        elif isinstance(target, ast.Attribute):
                            base = target.value.id if isinstance(target.value, ast.Name) else None
                            calls.append({"caller": qualified, "callee": target.attr,
                                          "line": sub.lineno, "form": "attribute", "base": base})

        visit_body(tree.body)
        results["files"].append({
            "path": rel, "symbols": symbols, "imports": imports, "calls": calls,
        })

    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
