/**
 * A GitHub link to a repository path at a pinned revision, or null when the
 * source is not a GitHub repository URL or no revision was recorded.
 */
export function githubSourceUrl(
  source: string | null | undefined,
  revision: string | null | undefined,
  path: string,
  lines?: { start: number | null; end: number | null },
) {
  if (!source || !revision) return null;
  if (!/^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(source))
    return null;
  const repositoryUrl = source.replace(/\/$/, "").replace(/\.git$/i, "");
  const safePath = path.split("/").map(encodeURIComponent).join("/");
  const url = `${repositoryUrl}/blob/${encodeURIComponent(revision)}/${safePath}`;
  if (!lines?.start) return url;
  return lines.end && lines.end !== lines.start
    ? `${url}#L${lines.start}-L${lines.end}`
    : `${url}#L${lines.start}`;
}
