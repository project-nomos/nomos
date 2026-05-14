import { NextResponse } from "next/server";

/**
 * Validates the Origin header for mutating requests. Accepts requests with:
 *   - no Origin header (non-browser clients, e.g. curl, native apps)
 *   - Origin matching localhost / 127.0.0.1
 *   - Origin whose host matches the request's Host header (same-origin)
 * The last case covers users accessing the Settings UI via the machine's
 * hostname, mDNS (.local), Tailscale IP, etc.
 */
export function validateOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (originHost.startsWith("localhost") || originHost.startsWith("127.0.0.1")) {
    return null;
  }

  const host = request.headers.get("host");
  if (host && originHost === host) return null;

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
