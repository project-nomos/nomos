import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function GET() {
  const accounts: Array<{ email: string; default: boolean }> = [];

  try {
    const { stdout } = await execFileAsync("npx", ["gws", "auth", "list"], { timeout: 10000 });
    const data = JSON.parse(stdout);
    const defaultAccount = data.default ?? "";
    for (const email of data.accounts ?? []) {
      accounts.push({ email, default: email === defaultAccount });
    }
  } catch {
    // gws not available or no accounts
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

  try {
    await execFileAsync("npx", ["gws", "auth", "logout", "--account", email], { timeout: 10000 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to remove account: ${message}` }, { status: 500 });
  }
}
