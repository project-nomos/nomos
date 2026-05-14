import { NextResponse } from "next/server";
import { validateOrigin } from "@/lib/validate-request";

export async function POST(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  const body = (await request.json()) as {
    provider: "anthropic" | "anthropic-subscription" | "vertex";
    apiKey?: string;
    projectId?: string;
    region?: string;
  };

  if (body.provider === "anthropic-subscription") {
    // Check if Claude Code is logged in (~/.claude/.credentials.json exists with valid OAuth)
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync("claude", ["auth", "status"], { timeout: 5000 });
      const data = JSON.parse(stdout);
      if (data.loggedIn) {
        return NextResponse.json({
          valid: true,
          warning: `Signed in as ${data.email ?? "unknown"} (${data.subscriptionType ?? "subscription"})`,
        });
      }
      return NextResponse.json({
        valid: false,
        error: "Not signed in to Claude. Run `claude login` in a terminal first.",
      });
    } catch {
      return NextResponse.json({
        valid: false,
        error:
          "Claude Code CLI not found. Install it (npm i -g @anthropic-ai/claude-code) and run `claude login`.",
      });
    }
  }

  if (body.provider === "anthropic") {
    if (!body.apiKey) {
      return NextResponse.json({ valid: false, error: "API key is required" }, { status: 400 });
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
        (data as Record<string, unknown>)?.error?.toString() ?? `API returned status ${res.status}`;
      return NextResponse.json({ valid: false, error: errorMsg });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to validate key";
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

  return NextResponse.json({ valid: false, error: "Unknown provider" }, { status: 400 });
}
