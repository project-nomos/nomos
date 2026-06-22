/**
 * Diagnose the hosted Google integration end-to-end. Lists the connected accounts,
 * mints a fresh access token (proving the refresh token works), and calls the
 * Calendar Data API directly so Google's VERBATIM error is printed — e.g.
 * "Google Calendar API has not been used in project NNN before or it is disabled.
 * Enable it by visiting <link>". The official remote MCP swallows that into a tool
 * result the daemon never logs, which is why "no error in the logs".
 *
 * Run in the daemon's environment (so DATABASE_URL / ENCRYPTION_KEY / GOOGLE creds
 * are loaded the same way the daemon loads them):
 *   pnpm tsx scripts/diagnose-google.ts <userId>
 *
 * Prints only metadata + the API response — never the token or any secret value.
 */

import { config } from "dotenv";
import { homedir } from "node:os";
import { join } from "node:path";

config({ path: join(homedir(), ".nomos", ".env"), quiet: true });
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const userId = process.argv[2];
if (!userId) {
  console.error("usage: pnpm tsx scripts/diagnose-google.ts <userId>");
  process.exit(1);
}

async function main(): Promise<void> {
  const { listGoogleAccounts, getValidAccessToken } =
    await import("../src/auth/google-integration.ts");

  const accounts = await listGoogleAccounts(userId);
  console.log(
    "connected accounts:",
    accounts.map((a) => ({
      email: a.email,
      isDefault: a.isDefault,
      tokenExpiry: a.expiresAt ? new Date(a.expiresAt * 1000).toISOString() : "(none)",
    })),
  );
  if (accounts.length === 0) {
    console.log("NO ACCOUNTS for this userId — wrong DB/env, or not connected.");
    return;
  }

  const email = accounts.find((a) => a.isDefault)?.email ?? accounts[0]!.email;
  const token = await getValidAccessToken(userId, email);
  if (!token) {
    console.log(`NO VALID TOKEN for ${email} — refresh failed (likely no refresh token stored).`);
    return;
  }
  console.log(`minted a valid access token for ${email} (length ${token.length}) — refresh works.`);

  // Probe the underlying Calendar Data API with the user's token. A 200 means the
  // calendar will work; a 403 SERVICE_DISABLED prints exactly which API + project.
  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  console.log(`\ncalendar.googleapis.com → HTTP ${res.status}`);
  console.log((await res.text()).slice(0, 2000));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
