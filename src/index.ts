import process from "node:process";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "dotenv";
import { buildProgram } from "./cli/program.ts";
import { ensureNomosEnvFile, envLoadOrder, isSourceRun } from "./config/env-bootstrap.ts";
import { ensureEncryptionKey } from "./db/encryption.ts";
import { installRejectionHandler } from "./lib/rejection-handler.ts";

// Load env vars. The installed binary lets ~/.nomos/.env take precedence over a
// stray .env in the current working directory (running nomos from another
// project's folder must not hijack DATABASE_URL); a source run keeps repo .env
// first for development. See src/config/env-bootstrap.ts.
const nomosDir = join(homedir(), ".nomos");
const sourceRun = isSourceRun(import.meta.url);
if (!sourceRun) ensureNomosEnvFile(nomosDir);
for (const paths of envLoadOrder(nomosDir, sourceRun)) {
  config({ path: paths, quiet: true });
}

// Ensure encryption key exists (reads ~/.nomos/encryption.key or generates one)
ensureEncryptionKey();

// A revoked channel token (Slack/Discord/Telegram) can surface as a background
// unhandled rejection. The daemon must survive it, not crash-loop under launchd
// KeepAlive. Log, never exit. See src/lib/rejection-handler.ts.
installRejectionHandler();

const program = buildProgram();
await program.parseAsync(process.argv);
