import fs from "node:fs/promises";
import path from "node:path";
import { FEATURES } from "../config/mode.ts";

/** Shape of an MCP server config entry in the config file */
export interface McpFileServerConfig {
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

const CONFIG_PATHS = [".nomos/mcp.json", ".nomos/mcp-servers.json"];

export async function loadMcpConfig(): Promise<Record<string, McpFileServerConfig> | null> {
  // Hosted mode does not honor BYO MCP servers — the only MCPs available are
  // the in-process channel/memory ones registered by the daemon itself.
  if (!FEATURES.byoMcp()) return null;

  // Try loading from current directory first, then home directory
  const searchDirs = [process.cwd(), process.env.HOME ?? ""];

  for (const dir of searchDirs) {
    for (const configPath of CONFIG_PATHS) {
      const fullPath = path.join(dir, configPath);
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        const parsed = JSON.parse(content);

        if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
          return parsed.mcpServers;
        }

        // Also support flat format
        if (typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // File doesn't exist or is invalid, continue
      }
    }
  }

  return null;
}
