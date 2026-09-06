import { ZodError } from "zod";
import {
  deleteRepository,
  getRepository,
  listRepositories,
  saveRepository,
} from "../../../db/repositories";
import { parseRepoGraphFile } from "../../graph/schema";

export const dynamic = "force-dynamic";

const maxGraphBytes = 5 * 1024 * 1024;

function errorResponse(error: unknown) {
  if (error instanceof SyntaxError) {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (error instanceof ZodError) {
    return Response.json(
      {
        error: "Invalid repository graph",
        issues: error.issues.slice(0, 8).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return Response.json({ error: message }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const repositoryId = new URL(request.url).searchParams.get("id");
    if (repositoryId) {
      const repository = await getRepository(repositoryId);
      if (!repository) {
        return Response.json({ error: "Repository not found" }, { status: 404 });
      }
      return Response.json({ repository }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json(
      { repositories: await listRepositories() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return Response.json({ error: "Expected application/json" }, { status: 415 });
    }
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > maxGraphBytes) {
      return Response.json({ error: "Graph file exceeds the 5 MB limit" }, { status: 413 });
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > maxGraphBytes) {
      return Response.json({ error: "Graph file exceeds the 5 MB limit" }, { status: 413 });
    }
    const graphFile = parseRepoGraphFile(JSON.parse(rawBody));
    await saveRepository(graphFile);
    return Response.json(
      { repositoryId: graphFile.repository.id },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const repositoryId = new URL(request.url).searchParams.get("id")?.trim();
    if (!repositoryId) {
      return Response.json({ error: "Repository id is required" }, { status: 400 });
    }
    await deleteRepository(repositoryId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
