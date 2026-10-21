import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(projectRoot, ".agents", "skills");
const skills = readdirSync(skillsRoot);

// Files a skill carries a copy of so it works outside this checkout, keyed by the original.
const bundled = {
  "scripts/validate-graph.mjs": "repo-graph/scripts/validate-graph.mjs",
  "schemas/repo-graph.schema.json": "repo-graph/references/repo-graph.schema.json",
};

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  return Object.fromEntries(
    match[1].split("\n").map((line) => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }),
  );
}

function markdownFiles(directory) {
  return readdirSync(directory, { recursive: true })
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(directory, name));
}

test("bundled copies match their originals", () => {
  for (const [original, copy] of Object.entries(bundled)) {
    assert.equal(
      readFileSync(join(skillsRoot, copy), "utf8"),
      readFileSync(join(projectRoot, original), "utf8"),
      `${copy} differs from ${original}; run make sync-skills`,
    );
  }
});

test("every skill names itself after its directory and has a description", () => {
  for (const skill of skills) {
    const meta = frontmatter(readFileSync(join(skillsRoot, skill, "SKILL.md"), "utf8"));
    assert.ok(meta, `${skill}/SKILL.md has no frontmatter`);
    assert.equal(meta.name, skill);
    assert.match(meta.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(meta.description, `${skill} has no description`);
    assert.ok(meta.description.length <= 1024, `${skill} description exceeds 1024 characters`);
  }
});

test("every relative link in a skill resolves", () => {
  for (const skill of skills) {
    for (const file of markdownFiles(join(skillsRoot, skill))) {
      for (const [, target] of readFileSync(file, "utf8").matchAll(/\]\(([^)#\s]+)\)/g)) {
        if (/^[a-z]+:/i.test(target)) continue;
        assert.ok(existsSync(resolve(dirname(file), target)), `${file} links to missing ${target}`);
      }
    }
  }
});

test("Claude Code sees every skill through a .claude/skills symlink", () => {
  for (const skill of skills) {
    const link = join(projectRoot, ".claude", "skills", skill);
    assert.ok(existsSync(link), `.claude/skills/${skill} is missing`);
    assert.ok(lstatSync(link).isSymbolicLink(), `.claude/skills/${skill} should be a symlink`);
    assert.equal(realpathSync(link), realpathSync(join(skillsRoot, skill)));
  }
});
