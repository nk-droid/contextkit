// contextkit view against a fake explorer. Starting the real one needs its web dependencies
// and up to a minute, so these tests cover detection, import, links, and error reporting.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-view-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const graph = {
  schemaVersion: 1,
  repository: { id: "demo", name: "Demo", source: "test" },
  graphs: [{ id: "architecture", kind: "architecture", title: "Architecture", description: "Demo.", nodes: [], edges: [] }],
};
const facts = {
  schemaVersion: 1,
  repository: { id: "demo-network", name: "Demo" },
  architecture: { components: [] },
  code: { symbols: [], calls: [] },
};

function write(name, value) {
  const file = path.join(temp, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

/** An HTTP server standing in for the explorer, recording every request it receives. */
function fakeExplorer(respond) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, type: request.headers["content-type"], body });
      const [status, payload] = respond(request);
      const json = typeof payload !== "string";
      response.writeHead(status, { "content-type": json ? "application/json" : "text/html" });
      response.end(json ? JSON.stringify(payload) : payload);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    port: server.address().port, requests, close: () => new Promise((done) => server.close(done)),
  })));
}

const explorer = (request) => (request.method === "GET"
  ? [200, { repositories: [] }]
  : [201, { repositoryId: request.url.startsWith("/api/facts") ? "demo-network" : "demo" }]);

// Spawned, not run synchronously: the fake explorer shares this process's event loop.
function view(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "bin/contextkit-view"), ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("imports network facts into a running explorer and links the network page", async () => {
  const fake = await fakeExplorer(explorer);
  try {
    const file = write("one/NETWORK_FACTS.json", facts);
    const result = await view(file, "--port", String(fake.port), "--no-open");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`http://localhost:${fake.port}/network\\?repo=demo-network`));
    const post = fake.requests.find((r) => r.method === "POST");
    assert.equal(post.url, "/api/facts");
    assert.equal(post.type, "application/json");
    assert.equal(post.body, fs.readFileSync(file, "utf8"));
  } finally {
    await fake.close();
  }
});

test("a directory imports both outputs and links the atlas and the network page", async () => {
  const fake = await fakeExplorer(explorer);
  try {
    write("both/REPO_GRAPH.json", graph);
    write("both/NETWORK_FACTS.json", facts);
    const result = await view(path.join(temp, "both"), "--port", String(fake.port), "--no-open");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fake.requests.filter((r) => r.method === "POST").map((r) => r.url), ["/api/repositories", "/api/facts"]);
    assert.match(result.stdout, new RegExp(`http://localhost:${fake.port}/\\n`));
    assert.match(result.stdout, /\/network\?repo=demo-network/);
  } finally {
    await fake.close();
  }
});

test("a rejected import reports the explorer's validation errors", async () => {
  const fake = await fakeExplorer((request) => (request.method === "GET"
    ? [200, { repositories: [] }]
    : [400, { error: "Invalid repository graph", issues: [{ path: "graphs.0.nodes", message: "Required" }] }]));
  try {
    const result = await view(write("bad/REPO_GRAPH.json", graph), "--port", String(fake.port), "--no-open");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid repository graph/);
    assert.match(result.stderr, /graphs\.0\.nodes: Required/);
  } finally {
    await fake.close();
  }
});

test("files that are not ContextKit output are refused before anything is sent", async () => {
  const fake = await fakeExplorer(explorer);
  try {
    const other = await view(write("other.json", { hello: "world" }), "--port", String(fake.port), "--no-open");
    assert.equal(other.status, 2);
    assert.match(other.stderr, /neither a repository graph nor a network facts document/);
    fs.mkdirSync(path.join(temp, "empty"));
    const empty = await view(path.join(temp, "empty"), "--port", String(fake.port), "--no-open");
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /contains neither REPO_GRAPH\.json nor NETWORK_FACTS\.json/);
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test("a port held by another program is not mistaken for the explorer", async () => {
  const fake = await fakeExplorer(() => [404, "<html>Not found</html>"]);
  try {
    const result = await view(write("port/NETWORK_FACTS.json", facts), "--port", String(fake.port), "--no-open");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /used by something other than the ContextKit explorer; pass --port/);
    assert.equal(fake.requests.filter((r) => r.method === "POST").length, 0);
  } finally {
    await fake.close();
  }
});
