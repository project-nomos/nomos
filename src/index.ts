import process from "node:process";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "dotenv";
import { buildProgram } from "./cli/program.ts";
import { ensureEncryptionKey } from "./db/encryption.ts";

// Load env vars: cwd first, then ~/.nomos/ as fallback for Homebrew installs
const nomosDir = join(homedir(), ".nomos");
config({ path: [".env.local", ".env"], quiet: true });
config({ path: [join(nomosDir, ".env.local"), join(nomosDir, ".env")], quiet: true });

// Ensure encryption key exists (reads ~/.nomos/encryption.key or generates one)
ensureEncryptionKey();

// Suppress known SDK cleanup race: ProcessTransport closes before pending
// MCP control requests finish. Harmless — the session is already done.
process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error && reason.message.includes("ProcessTransport is not ready")) {
    return;
  }
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

const program = buildProgram();
await program.parseAsync(process.argv);
