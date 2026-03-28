/**
 * Notify the running daemon to reload Slack workspaces.
 * Uses the CLI as a bridge to send a gRPC command.
 * Non-blocking — failures are silently ignored (daemon may not be running).
 */

import { exec } from "node:child_process";
import path from "node:path";

export function notifyDaemonReload(): void {
  const rootDir = path.resolve(process.cwd(), "..");
  const entryPoint = path.resolve(rootDir, "src", "index.ts");

  // Fire-and-forget: use the daemon's gRPC endpoint via a quick node script
  const script = `
    const grpc = require("@grpc/grpc-js");
    const protoLoader = require("@grpc/proto-loader");
    const path = require("path");
    const proto = path.join(${JSON.stringify(rootDir)}, "proto", "nomos.proto");
    const def = protoLoader.loadSync(proto, { keepCase: false, defaults: true });
    const desc = grpc.loadPackageDefinition(def);
    const client = new desc.nomos.NomosAgent("localhost:8766", grpc.credentials.createInsecure());
    client.command({ command: "reload-slack-workspaces", sessionKey: "settings" }, (err, res) => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000);
  `;

  exec(
    `node -e '${script.replace(/'/g, "\\'")}'`,
    {
      cwd: rootDir,
      timeout: 5000,
    },
    () => {
      // Ignore errors — daemon may not be running
    },
  );
}
