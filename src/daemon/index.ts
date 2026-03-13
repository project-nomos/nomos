/**
 * Daemon entry point.
 *
 * Usage: tsx src/daemon/index.ts [--port 8765]
 */

import { config } from "dotenv";
import { Gateway } from "./gateway.ts";

// Load environment
config({ path: [".env.local", ".env"], quiet: true });

const port = process.env.DAEMON_PORT ? parseInt(process.env.DAEMON_PORT, 10) : 8765;

const gateway = new Gateway({ port });
await gateway.start();
