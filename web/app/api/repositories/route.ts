import {
  deleteRepository,
  getRepository,
  listRepositories,
  saveRepository,
} from "../../../db/repositories";
import { parseRepoGraphFile } from "../../graph/schema";
import { errorResponse, readJsonBody } from "../responses";

export const dynamic = "force-dynamic";

const maxGraphBytes = 5 * 1024 * 1024;
const invalidGraph = "Invalid repository graph";

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
    return errorResponse(error, invalidGraph);
  }
}

export async function POST(request: Request) {
  try {
    const graphFile = parseRepoGraphFile(
      await readJsonBody(request, maxGraphBytes, "Graph file"),
    );
    await saveRepository(graphFile);
    return Response.json(
      { repositoryId: graphFile.repository.id },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error, invalidGraph);
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
    return errorResponse(error, invalidGraph);
  }
}
