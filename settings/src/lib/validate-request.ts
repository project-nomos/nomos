import { NextResponse } from "next/server";

/**
 * Validates the Origin header for mutating requests.
 * Returns a 403 Response if the origin is not localhost, or null if valid.
 */
export function validateOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (origin && !origin.startsWith("http://localhost") && !origin.startsWith("http://127.0.0.1")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}
