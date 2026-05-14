import { NextResponse, type NextRequest } from "next/server";

/**
 * Redirect to /setup until first-run configuration is complete.
 *
 * Without this, users who navigate directly to /dashboard or /integrations
 * skip the onboarding wizard. We can't call the DB from middleware (Edge
 * runtime, no postgres client), so we make a lightweight fetch to the
 * dedicated /api/setup/status endpoint which the page.tsx already uses.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow: API routes, the setup wizard itself, static assets
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/setup") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname === "/"
  ) {
    return NextResponse.next();
  }

  try {
    const statusUrl = new URL("/api/setup/status", request.url);
    const res = await fetch(statusUrl, { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { complete?: boolean };
      if (!data.complete) {
        return NextResponse.redirect(new URL("/setup", request.url));
      }
    }
  } catch {
    // If the status endpoint fails (e.g., DB unreachable), don't block --
    // user might be on /admin/database trying to fix it.
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon).*)"],
};
