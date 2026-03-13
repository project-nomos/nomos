import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const dynamic = "force-dynamic";

export async function GET() {
  const pidPath = path.join(os.homedir(), ".nomos", "daemon.pid");

  try {
    if (!fs.existsSync(pidPath)) {
      return NextResponse.json({ running: false });
    }

    const content = fs.readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid)) {
      return NextResponse.json({ running: false });
    }

    // Check if process is alive (signal 0 doesn't kill, just checks)
    try {
      process.kill(pid, 0);
    } catch {
      // Process not running — stale PID file, clean it up
      try {
        fs.unlinkSync(pidPath);
      } catch {
        // Ignore cleanup errors
      }
      return NextResponse.json({ running: false });
    }

    return NextResponse.json({ running: true, pid });
  } catch {
    return NextResponse.json({ running: false });
  }
}
