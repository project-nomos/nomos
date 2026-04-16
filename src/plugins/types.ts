import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";

export type { SdkPluginConfig };

export interface PluginManifest {
  name: string;
  description: string;
  version?: string;
  author?: { name: string; email?: string };
}

export interface InstalledPluginEntry {
  name: string;
  version: string;
  marketplace: string;
  source: "plugins" | "external_plugins";
  installedAt: string;
}

export interface InstalledManifest {
  version: 1;
  plugins: InstalledPluginEntry[];
}

export interface LoadedPlugin {
  name: string;
  description: string;
  path: string;
  marketplace: string;
  sdkConfig: SdkPluginConfig;
}

export interface AvailablePlugin {
  name: string;
  description: string;
  author?: string;
  source: "plugins" | "external_plugins";
  marketplace: string;
  installed: boolean;
}

export const DEFAULT_PLUGINS: ReadonlyArray<{
  name: string;
  source: "plugins" | "external_plugins";
}> = [
  // First-party (plugins/)
  { name: "agent-sdk-dev", source: "plugins" },
  { name: "code-review", source: "plugins" },
  { name: "code-simplifier", source: "plugins" },
  { name: "commit-commands", source: "plugins" },
  { name: "feature-dev", source: "plugins" },
  { name: "frontend-design", source: "plugins" },
  { name: "hookify", source: "plugins" },
  { name: "learning-output-style", source: "plugins" },
  { name: "math-olympiad", source: "plugins" },
  { name: "mcp-server-dev", source: "plugins" },
  { name: "plugin-dev", source: "plugins" },
  { name: "pr-review-toolkit", source: "plugins" },
  { name: "security-guidance", source: "plugins" },
  { name: "skill-creator", source: "plugins" },
  // Community (external_plugins/)
  { name: "discord", source: "external_plugins" },
  { name: "github", source: "external_plugins" },
  { name: "imessage", source: "external_plugins" },
  { name: "linear", source: "external_plugins" },
  { name: "playwright", source: "external_plugins" },
  { name: "telegram", source: "external_plugins" },
  { name: "terraform", source: "external_plugins" },
];
