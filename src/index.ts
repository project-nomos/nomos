import process from "node:process";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "dotenv";
import { buildProgram } from "./cli/program.ts";
import { ensureEncryptionKey } from "./db/encryption.ts";
import { installRejectionHandler } from "./lib/rejection-handler.ts";

// Load env vars: cwd first, then ~/.nomos/ as fallback for Homebrew installs
const nomosDir = join(homedir(), ".nomos");
config({ path: [".env.local", ".env"], quiet: true });
config({ path: [join(nomosDir, ".env.local"), join(nomosDir, ".env")], quiet: true });

// Ensure encryption key exists (reads ~/.nomos/encryption.key or generates one)
ensureEncryptionKey();

// A revoked channel token (Slack/Discord/Telegram) can surface as a background
// unhandled rejection. The daemon must survive it, not crash-loop under launchd
// KeepAlive. Log, never exit. See src/lib/rejection-handler.ts.
installRejectionHandler();

const program = buildProgram();
await program.parseAsync(process.argv);
