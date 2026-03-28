import process from "node:process";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "dotenv";
import { buildProgram } from "./cli/program.ts";

// Load env vars: cwd first, then ~/.nomos/ as fallback for Homebrew installs
const nomosDir = join(homedir(), ".nomos");
config({ path: [".env.local", ".env"], quiet: true });
config({ path: [join(nomosDir, ".env.local"), join(nomosDir, ".env")], quiet: true });

const program = buildProgram();
await program.parseAsync(process.argv);
