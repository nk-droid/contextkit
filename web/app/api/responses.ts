import { ZodError } from "zod";

/** A request the route rejects before reading or validating its content. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function readJsonBody(request: Request, maxBytes: number, label: string) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new RequestError("Expected application/json", 415);
  }
  const tooLarge = `${label} exceeds the ${maxBytes / 1024 / 1024} MB limit`;
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) throw new RequestError(tooLarge, 413);
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > maxBytes) {
    throw new RequestError(tooLarge, 413);
  }
  return JSON.parse(rawBody) as unknown;
}

export function errorResponse(error: unknown, invalidDocumentMessage: string) {
  if (error instanceof RequestError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (error instanceof ZodError) {
    return Response.json(
      {
        error: invalidDocumentMessage,
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
