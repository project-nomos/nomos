/**
 * Daemon entry point.
 *
 * Usage: tsx src/daemon/index.ts [--port 8765]
 */

import { config } from "dotenv";
import { ensureEncryptionKey } from "../db/encryption.ts";
import { Gateway } from "./gateway.ts";

// Load environment
config({ path: [".env.local", ".env"], quiet: true });

// Load the encryption key from ~/.nomos/encryption.key into process.env
// BEFORE any code reads integration secrets. The CLI entry point already
// does this; the daemon entry point was missing it, which caused decrypt()
// to no-op and the CATE keystore + Slack workspace adapter to read empty
// secrets ("not_authed", JSON parse errors on the raw IV hex).
ensureEncryptionKey();

const port = process.env.DAEMON_PORT ? parseInt(process.env.DAEMON_PORT, 10) : 8765;
const withSettings = process.env.DAEMON_WITH_SETTINGS !== "false";
const settingsPort = process.env.SETTINGS_PORT ? parseInt(process.env.SETTINGS_PORT, 10) : 3456;

const gateway = new Gateway({ port, withSettings, settingsPort });
await gateway.start();
