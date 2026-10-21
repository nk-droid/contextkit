"use client";

import Image from "next/image";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
} from "react";
import { ZodError } from "zod";
import type { FactsSummary } from "../../db/facts";
import { parseNetworkFacts, type NetworkFacts } from "../facts/schema";
import { NetworkExplorer } from "./NetworkExplorer";

type ThemeMode = "system" | "light" | "dark";
const themeModes: ThemeMode[] = ["system", "light", "dark"];
const themeStorageKey = "ck-theme";
const themeChangeEvent = "ck-theme-change";
// Used when storage is unavailable, so the toggle still works for the visit.
let unsavedTheme: ThemeMode = "system";

function readTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(themeStorageKey);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return unsavedTheme;
  }
}

function saveTheme(mode: ThemeMode) {
  unsavedTheme = mode;
  try {
    localStorage.setItem(themeStorageKey, mode);
  } catch {
    // Private windows can refuse storage; the in-memory choice still applies.
  }
  window.dispatchEvent(new Event(themeChangeEvent));
}

function subscribeToTheme(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(themeChangeEvent, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(themeChangeEvent, onChange);
  };
}

async function responseError(response: Response) {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string; issues?: { path: string; message: string }[] }
    | null;
  const issue = payload?.issues?.[0];
  return issue
    ? `${payload?.error}: ${issue.path} ${issue.message}`
    : payload?.error ?? `Request failed (${response.status})`;
}

function importError(error: unknown, document: unknown) {
  if (error instanceof SyntaxError) return "not valid JSON";
  if (error instanceof ZodError) {
    if (document && typeof document === "object" && "graphs" in document) {
      return "this is a repository graph (REPO_GRAPH.json); import it in the repository atlas";
    }
    const issue = error.issues[0];
    return `not a context facts document: ${issue.path.join(".") || "document"} ${issue.message}`;
  }
  return error instanceof Error ? error.message : "could not be imported";
}

export function ComponentNetwork() {
  const [library, setLibrary] = useState<FactsSummary[]>([]);
  const [facts, setFacts] = useState<NetworkFacts | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const theme = useSyncExternalStore(subscribeToTheme, readTheme, () => "system" as const);

  const showMessage = useCallback((text: string, isError = false) => {
    setMessage({ text, isError });
    window.setTimeout(() => setMessage(null), 5000);
  }, []);

  const activate = useCallback((next: NetworkFacts) => {
    setFacts(next);
    const url = new URL(window.location.href);
    url.searchParams.set("repo", next.repository.id);
    window.history.replaceState(null, "", url);
  }, []);

  const refreshLibrary = useCallback(async () => {
    const response = await fetch("/api/facts", { cache: "no-store" });
    if (!response.ok) throw new Error(await responseError(response));
    const payload = (await response.json()) as { documents: FactsSummary[] };
    setLibrary(payload.documents);
    return payload.documents;
  }, []);

  const loadFacts = useCallback(
    async (repositoryId: string) => {
      setLoading(true);
      try {
        const response = await fetch(
          `/api/facts?id=${encodeURIComponent(repositoryId)}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error(await responseError(response));
        const payload = (await response.json()) as { facts: unknown };
        activate(parseNetworkFacts(payload.facts));
      } catch (error) {
        showMessage(
          error instanceof Error ? error.message : "Could not load context facts",
          true,
        );
      } finally {
        setLoading(false);
      }
    },
    [activate, showMessage],
  );

  useEffect(() => {
    void (async () => {
      try {
        const stored = await refreshLibrary();
        const requested = new URLSearchParams(window.location.search).get("repo");
        const initial = stored.find((item) => item.id === requested) ?? stored[0];
        if (initial) await loadFacts(initial.id);
      } catch (error) {
        showMessage(
          error instanceof Error ? error.message : "Could not open the facts library",
          true,
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [loadFacts, refreshLibrary, showMessage]);

  const importFiles = async (fileList: FileList | null) => {
    // Copied before the first await: clearing the input empties the live list.
    const files = [...(fileList ?? [])];
    if (!files.length) return;
    let latest: NetworkFacts | null = null;
    const failures: string[] = [];

    for (const file of files) {
      let document: unknown = null;
      try {
        document = JSON.parse(await file.text());
        // Parsing keeps only what the network reads, so that is all that is uploaded.
        const parsed = parseNetworkFacts(document);
        const response = await fetch("/api/facts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed),
        });
        if (!response.ok) throw new Error(await responseError(response));
        latest = parsed;
      } catch (error) {
        failures.push(`${file.name}: ${importError(error, document)}`);
      }
    }

    if (latest) {
      activate(latest);
      await refreshLibrary().catch(() => undefined);
    }
    if (failures.length) {
      const saved = files.length - failures.length;
      showMessage(saved ? `${saved} saved · ${failures[0]}` : failures[0], true);
    } else {
      showMessage(
        files.length === 1
          ? `Saved ${latest?.repository.displayName || latest?.repository.name} to SQLite.`
          : `${files.length} facts documents saved to SQLite.`,
      );
    }
  };

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    void importFiles(event.target.files);
    event.target.value = "";
  };

  const repository = facts?.repository;
  const railHeader = (
    <div className="nw-rail-head">
      <div className="nw-rail-brand">
        <Image alt="" className="nw-brand-mark" height={30} src="/favicon.svg" width={30} />
        <div>
          <strong>ContextKit</strong>
          <span>Component network</span>
        </div>
      </div>
      <section className="nw-rail-section">
        <div className="nw-rail-heading-row">
          <h2 className="nw-rail-heading">Repository</h2>
          <button
            className="nw-rail-link"
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            ＋ Import facts
          </button>
        </div>
        {library.length ? (
          <select
            aria-label="Repository"
            className="nw-select"
            onChange={(event) => void loadFacts(event.target.value)}
            value={repository?.id ?? ""}
          >
            {repository ? null : <option value="">Choose a repository</option>}
            {library.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        ) : null}
        {repository ? (
          <p className="nw-rail-meta">
            {repository.sourceLabel || repository.name} ·{" "}
            {repository.revision?.slice(0, 7) ?? "working tree"}
          </p>
        ) : null}
        {facts?.coverage ? (
          <details className="nw-rail-meta">
            <summary>{facts.coverage.mode === "static" ? "Static directory network" : "Semantic network"} · Coverage</summary>
            <p>{facts.coverage.retainedSymbols} of {facts.coverage.discoveredSymbols} symbols retained; {facts.coverage.unresolvedCalls} unresolved calls.</p>
            {facts.coverage.missingLayers.length ? <p>Not analyzed: {facts.coverage.missingLayers.join(", ")}.</p> : null}
            {facts.coverage.unsupportedLanguages.length ? <p>No symbol adapter: {facts.coverage.unsupportedLanguages.join(", ")}.</p> : null}
            {facts.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
          </details>
        ) : null}
      </section>
    </div>
  );
  const railFooter = (
    <div className="nw-rail-foot">
      <button
        className="nw-rail-button"
        onClick={() => saveTheme(themeModes[(themeModes.indexOf(theme) + 1) % themeModes.length])}
        type="button"
      >
        Theme: {theme}
      </button>
      <Link className="nw-rail-button" href="/">
        ← Atlas
      </Link>
    </div>
  );

  return (
    <div className="nw-page" data-theme={theme === "system" ? undefined : theme}>
      <input
        accept=".json,application/json"
        className="visually-hidden"
        multiple
        onChange={handleFiles}
        ref={fileInputRef}
        type="file"
      />

      {facts ? (
        <NetworkExplorer
          facts={facts}
          key={`${facts.repository.id} ${facts.artifactId}`}
          railFooter={railFooter}
          railHeader={railHeader}
        />
      ) : (
        <>
          <aside className="nw-rail">
            {railHeader}
            <div className="nw-rail-body" />
            {railFooter}
          </aside>
          <main className="nw-main">
            <section className="nw-empty">
              <span className="nw-eyebrow">
                {loading ? "Opening library" : "No context facts yet"}
              </span>
              <h2>{loading ? "Checking SQLite…" : "Import a repository's context facts"}</h2>
              <p>
                The network is drawn from a context facts document — the{" "}
                <code>ContextFactsDocument</code> contract in{" "}
                <code>schemas/context-facts.schema.json</code>. Import one to see how its
                components, stores, and declarations connect. Only the parts the network uses
                are stored.
              </p>
              <button
                className="nw-primary"
                disabled={loading}
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                Choose facts file
              </button>
            </section>
          </main>
        </>
      )}

      {message ? (
        <div className={`nw-toast${message.isError ? " is-error" : ""}`} role="status">
          {message.text}
        </div>
      ) : null}
    </div>
  );
}
