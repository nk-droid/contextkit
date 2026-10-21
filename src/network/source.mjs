import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { slug, shortHash } from "../analysis/stable-ids.mjs";

export const toolkitRoot = fileURLToPath(new URL("../../", import.meta.url));
const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);

export function resolveSource(input) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    const root = fs.realpathSync(path.resolve(input));
    if (!fs.statSync(root).isDirectory()) throw new Error("Source must be a repository directory, run directory, or public Git URL");
    return { root, identity: root, name: path.basename(root), cleanup() {} };
  }
  const url = new URL(input);
  if (!["http:", "https:", "file:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use a public HTTP(S) Git clone URL without credentials, or a file:// Git mirror");
  }
  const name = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "repository").replace(/\.git$/, "");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "contextkit-network-clone-"));
  const root = path.join(temporary, slug(name) || "repository");
  const clone = spawnSync("git", ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--no-recurse-submodules", "--", url.href, root], {
    encoding: "utf8", timeout: 180_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (clone.status !== 0) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw new Error(`Git clone failed: ${clone.error?.message ?? clone.stderr?.trim() ?? "unknown error"}`);
  }
  return { root, name, identity: url.href, cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }) };
}

export function defaultOutput(source) {
  // Running from inside the analyzed repository must not cause writes into it.
  const base = within(source.root, toolkitRoot)
    ? path.join(os.tmpdir(), "contextkit-output") : path.join(toolkitRoot, "context-packs");
  return path.join(base, `${slug(source.name)}-${shortHash(source.identity, 8)}`, "NETWORK_FACTS.json");
}
