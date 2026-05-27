import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb } from "@/lib/db";

const execFileAsync = promisify(execFile);

export async function GET() {
  const accounts: Array<{ email: string; default: boolean }> = [];

  // Primary source: the on-disk multi-account manifest.
  try {
    const { listAccounts } = await import("@/lib/gws-accounts");
    for (const a of listAccounts()) {
      accounts.push({ email: a.email, default: a.isDefault });
    }
  } catch {
    // helper unavailable
  }

  // Fallback: DB rows (used by legacy single-account installs whose
  // manifest hasn't been populated yet).
  if (accounts.length === 0) {
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
  }

  // Also check gws auth status for the currently authenticated account
  try {
    const { stdout } = await execFileAsync("npx", ["@googleworkspace/cli", "auth", "status"], {
      timeout: 10000,
    });
    const status = JSON.parse(stdout);
    if (status.auth_method !== "none" || status.token_cache_exists) {
      // If no accounts in DB yet, try to resolve email from gws
      if (accounts.length === 0) {
        try {
          const { stdout: exportOut } = await execFileAsync(
            "npx",
            ["@googleworkspace/cli", "auth", "export", "--unmasked"],
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

  // Multi-account path: remove the per-account dir + manifest entry. This
  // also nukes the gws-stored refresh_token for the account, so no need
  // to call `gws auth logout` separately.
  try {
    const { listAccounts, removeAccountFromManifest } = await import("@/lib/gws-accounts");
    if (listAccounts().find((a) => a.email === email)) {
      removeAccountFromManifest(email);
    } else {
      // Legacy single-account install — fall back to global logout.
      try {
        await execFileAsync("npx", ["@googleworkspace/cli", "auth", "logout"], {
          timeout: 10_000,
        });
      } catch {
        // Token may already be invalid
      }
    }
  } catch {
    // gws-accounts helper unavailable — fall back to global logout.
    try {
      await execFileAsync("npx", ["@googleworkspace/cli", "auth", "logout"], { timeout: 10_000 });
    } catch {
      // Token may already be invalid
    }
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

/** PATCH /api/google/accounts — set the default account. */
export async function PATCH(request: NextRequest) {
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

  try {
    const { setDefaultAccount } = await import("@/lib/gws-accounts");
    setDefaultAccount(email);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // Mirror the change into the DB so other surfaces see it immediately.
  try {
    const sql = getDb();
    await sql`
      UPDATE integrations
      SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{is_default}', 'false'::jsonb),
          updated_at = now()
      WHERE name LIKE 'google-ws:%'
    `;
    const name = `google-ws:${email}`;
    await sql`
      UPDATE integrations
      SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{is_default}', 'true'::jsonb),
          updated_at = now()
      WHERE name = ${name}
    `;
  } catch {
    // Non-blocking — manifest is the source of truth.
  }

  return NextResponse.json({ ok: true });
}
