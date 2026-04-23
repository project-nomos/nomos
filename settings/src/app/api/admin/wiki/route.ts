import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET() {
  try {
    const sql = getDb();
    const articles = await sql`
      SELECT path, title, category, content, compiled_at
      FROM wiki_articles
      ORDER BY category, title
    `;
    return NextResponse.json({ articles });
  } catch {
    return NextResponse.json({ articles: [] });
  }
}

export async function POST() {
  try {
    // Trigger wiki compilation via daemon gRPC command
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    // Use the notify-daemon pattern to trigger compilation
    const path = await import("node:path");
    const rootDir = path.resolve(process.cwd(), "..");

    const script = `
      const grpc = require("@grpc/grpc-js");
      const protoLoader = require("@grpc/proto-loader");
      const path = require("path");
      const proto = path.join(${JSON.stringify(rootDir)}, "proto", "nomos.proto");
      const def = protoLoader.loadSync(proto, { keepCase: false, defaults: true });
      const desc = grpc.loadPackageDefinition(def);
      const client = new desc.nomos.NomosAgent("localhost:8766", grpc.credentials.createInsecure());
      client.command({ command: "wiki-compile", sessionKey: "settings" }, (err, res) => {
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000);
    `;

    exec(`node -e '${script.replace(/'/g, "\\'")}'`, { cwd: rootDir, timeout: 10000 }, () => {});

    return NextResponse.json({ ok: true, message: "Wiki compilation triggered" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
