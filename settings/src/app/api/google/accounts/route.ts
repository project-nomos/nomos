import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb } from "@/lib/db";

const execFileAsync = promisify(execFile);

export async function GET() {
  const accounts: Array<{ email: string; default: boolean }> = [];

  // Read accounts from DB (integrations table, google-ws:* naming)
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT name, metadata FROM integrations
      WHERE name LIKE 'google-ws:%' AND enabled = true
      ORDER BY metadata->>'is_default' DESC, name
    `;
    for (const row of rows) {
      const email = (row.name as string).replace(/^google-ws:/, "");
      const meta = row.metadata as Record<string, unknown>;
      accounts.push({ email, default: !!meta?.is_default });
    }
  } catch {
    // DB not available
  }

  // Also check gws auth status for the currently authenticated account
  try {
    const { stdout } = await execFileAsync("npx", ["gws", "auth", "status"], { timeout: 10000 });
    const status = JSON.parse(stdout);
    if (status.auth_method !== "none" || status.token_cache_exists) {
      // If no accounts in DB yet, try to resolve email from gws
      if (accounts.length === 0) {
        try {
          const { stdout: exportOut } = await execFileAsync(
            "npx",
            ["gws", "auth", "export", "--unmasked"],
            { timeout: 10000 },
          );
          const creds = JSON.parse(exportOut);
          if (creds.refresh_token && creds.client_id && creds.client_secret) {
            const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_id: creds.client_id,
                client_secret: creds.client_secret,
                refresh_token: creds.refresh_token,
                grant_type: "refresh_token",
              }),
            });
            if (tokenRes.ok) {
              const tokenData = await tokenRes.json();
              const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
              });
              if (userRes.ok) {
                const info = await userRes.json();
                if (info.email) {
                  accounts.push({ email: info.email, default: true });
                  // Persist to DB
                  try {
                    const sql = getDb();
                    const name = `google-ws:${info.email}`;
                    const metadata = JSON.stringify({ is_default: true });
                    await sql`
                      INSERT INTO integrations (name, enabled, config, secrets, metadata)
                      VALUES (${name}, true, '{}', '{}', ${metadata}::jsonb)
                      ON CONFLICT (name) DO UPDATE SET
                        metadata = ${metadata}::jsonb,
                        updated_at = now()
                    `;
                  } catch {
                    // Non-blocking
                  }
                }
              }
            }
          }
        } catch {
          // Could not resolve email
        }
      }
    }
  } catch {
    // gws not available
  }

  return NextResponse.json({ accounts });
}

export async function DELETE(request: NextRequest) {
  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const email = body.email?.trim();
  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  // Logout from gws (v0.22.5+ is single-account, no --account flag)
  try {
    await execFileAsync("npx", ["gws", "auth", "logout"], { timeout: 10000 });
  } catch {
    // Token may already be invalid
  }

  // Remove from DB
  try {
    const sql = getDb();
    const name = `google-ws:${email}`;
    await sql`DELETE FROM integrations WHERE name = ${name}`;
  } catch {
    // Non-blocking
  }

  return NextResponse.json({ ok: true });
}
