import {
  deleteFacts,
  FactsTooLargeError,
  getFacts,
  listFacts,
  saveFacts,
} from "../../../db/facts";
import { parseNetworkFacts } from "../../facts/schema";
import { errorResponse, readJsonBody } from "../responses";

export const dynamic = "force-dynamic";

// The browser uploads only the network's part of a facts document, but a
// complete document posted directly is accepted and cut down the same way.
const maxFactsBytes = 10 * 1024 * 1024;
const invalidFacts = "Invalid context facts document";

export async function GET(request: Request) {
  try {
    const repositoryId = new URL(request.url).searchParams.get("id");
    if (repositoryId) {
      const facts = await getFacts(repositoryId);
      if (!facts) {
        return Response.json({ error: "Context facts not found" }, { status: 404 });
      }
      return Response.json({ facts }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json(
      { documents: await listFacts() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, invalidFacts);
  }
}

export async function POST(request: Request) {
  try {
    const facts = parseNetworkFacts(
      await readJsonBody(request, maxFactsBytes, "Facts document"),
    );
    await saveFacts(facts);
    return Response.json({ repositoryId: facts.repository.id }, { status: 201 });
  } catch (error) {
    if (error instanceof FactsTooLargeError) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    return errorResponse(error, invalidFacts);
  }
}

export async function DELETE(request: Request) {
  try {
    const repositoryId = new URL(request.url).searchParams.get("id")?.trim();
    if (!repositoryId) {
      return Response.json({ error: "Repository id is required" }, { status: 400 });
    }
    await deleteFacts(repositoryId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, invalidFacts);
  }
}
