/**
 * Daemon entry point.
 *
 * Usage: tsx src/daemon/index.ts [--port 8765]
 */

import { config } from "dotenv";
import { Gateway } from "./gateway.ts";

// Load environment
config({ path: [".env.local", ".env"], quiet: true });

// Remove CLAUDECODE so SDK subprocesses don't refuse to start.
// This is set when the daemon is launched from inside a Claude Code terminal.
delete process.env.CLAUDECODE;

const port = process.env.DAEMON_PORT ? parseInt(process.env.DAEMON_PORT, 10) : 8765;
const withSettings = process.env.DAEMON_WITH_SETTINGS !== "false";
const settingsPort = process.env.SETTINGS_PORT ? parseInt(process.env.SETTINGS_PORT, 10) : 3456;

const gateway = new Gateway({ port, withSettings, settingsPort });
await gateway.start();
