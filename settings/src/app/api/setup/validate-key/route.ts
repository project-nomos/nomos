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
    // Validate the OAuth credentials file the SDK reads at runtime. We used
    // to shell out to `claude auth status`, but that requires the Claude
    // Code CLI to be installed on the machine running nomos — confusing for
    // users who only have it locally. The credentials file is what the
    // Anthropic SDK actually consumes, so checking it directly is more
    // accurate AND removes a dependency.
    try {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const credsPath = path.join(os.homedir(), ".claude", ".credentials.json");
      if (!fs.existsSync(credsPath)) {
        return NextResponse.json({
          valid: false,
          error:
            "No Claude OAuth credentials found at ~/.claude/.credentials.json. Run `claude login` on this machine, or copy the file from a machine where you're already signed in.",
        });
      }
      const raw = JSON.parse(fs.readFileSync(credsPath, "utf-8")) as {
        claudeAiOauth?: {
          accessToken?: string;
          refreshToken?: string;
          expiresAt?: number;
          subscriptionType?: string;
        };
      };
      const oauth = raw.claudeAiOauth;
      if (!oauth?.accessToken || !oauth?.refreshToken) {
        return NextResponse.json({
          valid: false,
          error:
            "~/.claude/.credentials.json is present but missing OAuth tokens. Re-run `claude login`.",
        });
      }
      const expiresAt = oauth.expiresAt ?? 0;
      const expired = expiresAt > 0 && expiresAt < Date.now();
      return NextResponse.json({
        valid: true,
        warning: expired
          ? `Access token expired; SDK will refresh on first use (${oauth.subscriptionType ?? "subscription"}).`
          : `Signed in via OAuth (${oauth.subscriptionType ?? "subscription"}).`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to read credentials";
      return NextResponse.json({ valid: false, error: message });
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
