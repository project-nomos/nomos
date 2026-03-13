import { NextResponse } from "next/server";
import { validateOrigin } from "@/lib/validate-request";

export async function POST(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  const body = (await request.json()) as {
    provider: "anthropic" | "vertex";
    apiKey?: string;
    projectId?: string;
    region?: string;
  };

  if (body.provider === "anthropic") {
    if (!body.apiKey) {
      return NextResponse.json(
        { valid: false, error: "API key is required" },
        { status: 400 },
      );
    }

    try {
      // Make a minimal API call to validate the key
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": body.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "Hi" }],
        }),
      });

      if (res.ok) {
        return NextResponse.json({ valid: true });
      }

      // 401 = invalid key, other errors may still indicate a valid key
      if (res.status === 401) {
        return NextResponse.json({
          valid: false,
          error: "Invalid API key. Check your key and try again.",
        });
      }

      // 400, 429, etc. — key is valid but something else is wrong
      if (res.status === 429) {
        return NextResponse.json({
          valid: true,
          warning: "Rate limited, but key appears valid.",
        });
      }

      const data = await res.json().catch(() => null);
      const errorMsg =
        (data as Record<string, unknown>)?.error?.toString() ??
        `API returned status ${res.status}`;
      return NextResponse.json({ valid: false, error: errorMsg });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to validate key";
      return NextResponse.json({ valid: false, error: message });
    }
  }

  if (body.provider === "vertex") {
    // For Vertex AI, we can't easily validate — just check required fields
    if (!body.projectId) {
      return NextResponse.json(
        { valid: false, error: "GCP Project ID is required" },
        { status: 400 },
      );
    }
    return NextResponse.json({
      valid: true,
      warning:
        "Vertex AI credentials are validated via gcloud auth. Ensure you have run: gcloud auth application-default login",
    });
  }

  return NextResponse.json(
    { valid: false, error: "Unknown provider" },
    { status: 400 },
  );
}
