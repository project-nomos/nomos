import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function POST() {
  // Check if gws binary is available
  try {
    const { stdout } = await execFileAsync("npx", ["@googleworkspace/cli", "--version"], {
      timeout: 10000,
    });
    const version = stdout
      .trim()
      .replace(/^gws\s+/, "")
      .split("\n")[0];

    // Check auth status
    try {
      const { stdout: statusOut } = await execFileAsync(
        "npx",
        ["@googleworkspace/cli", "auth", "status"],
        {
          timeout: 10000,
        },
      );
      const status = JSON.parse(statusOut);

      if (
        status.auth_method === "none" &&
        !status.token_cache_exists &&
        status.storage === "none"
      ) {
        return NextResponse.json({
          ok: false,
          message: `gws ${version} is available but no account is authorized. Click "Authorize Account" to connect.`,
        });
      }
    } catch {
      return NextResponse.json({
        ok: false,
        message: `gws ${version} is available but auth status could not be determined.`,
      });
    }

    // Try a lightweight API call to verify token refresh works
    try {
      await execFileAsync(
        "npx",
        ["@googleworkspace/cli", "gmail", "users", "getProfile", "--params", '{"userId":"me"}'],
        { timeout: 15000 },
      );
      return NextResponse.json({
        ok: true,
        message: `gws ${version} ready -- API access verified`,
      });
    } catch (apiErr) {
      const errMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);

      // invalid_client: refresh_token was issued against a different
      // OAuth client than what's now in client_secret.json (usually
      // after credentials were rotated or rewritten). Re-auth required.
      if (/invalid_client/i.test(errMsg)) {
        return NextResponse.json({
          ok: false,
          message: `gws ${version} keyring is out of sync with client_secret.json (invalid_client). Click "Remove" on the authorized account then "Authorize Account" to re-link.`,
        });
      }

      // invalid_grant: refresh token expired or revoked.
      if (/invalid_grant/i.test(errMsg)) {
        return NextResponse.json({
          ok: false,
          message: `gws ${version} refresh token is expired or revoked. Click "Remove" then "Authorize Account" to renew.`,
        });
      }

      // 403 with insufficient scope: the granted scopes don't cover the
      // service being called. Re-auth with the right scopes.
      if (/insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(errMsg)) {
        return NextResponse.json({
          ok: false,
          message: `gws ${version} access token does not include Gmail scope. Re-authorize via "Remove" then "Authorize Account" (the OAuth flow requests all scopes explicitly).`,
        });
      }

      if (errMsg.includes("401") || errMsg.includes("credentials") || errMsg.includes("auth")) {
        return NextResponse.json({
          ok: false,
          message: `gws ${version} has credentials but tokens are invalid. Re-authorize by clicking "Authorize Account".`,
        });
      }

      // Non-auth error (API not enabled, project mismatch, etc.) -- auth itself is fine
      return NextResponse.json({
        ok: true,
        message: `gws ${version} ready -- authenticated`,
      });
    }
  } catch {
    return NextResponse.json({
      ok: false,
      message: "gws CLI not available. Ensure @googleworkspace/cli is installed.",
    });
  }
}
