import process from "node:process";
import { config } from "dotenv";
import { buildProgram } from "./cli/program.ts";

config({ path: [".env.local", ".env"], quiet: true });

const program = buildProgram();
await program.parseAsync(process.argv);
