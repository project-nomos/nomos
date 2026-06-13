/**
 * The assistant's out-of-the-box capabilities, surfaced read-only in the
 * consumer "Built-in tools" page (Advanced).
 *
 * The Claude marketplace plugins (loadInstalledPlugins) are all developer tools
 * (code-review, terraform, mcp-server-dev, ...), so they are not shown to
 * consumers. Instead this curated list communicates what the assistant can do
 * out of the box, distinct from the user-facing Skills. A real consumer
 * marketplace is a later iteration.
 */

export interface BuiltinTool {
  name: string;
  description: string;
}

export const BUILTIN_TOOLS: readonly BuiltinTool[] = [
  { name: "Web search", description: "Searches the web for current information." },
  { name: "Web browser", description: "Opens and reads websites to get things done." },
  {
    name: "Long-term memory",
    description: "Remembers facts, preferences, and past conversations.",
  },
  { name: "File reading & writing", description: "Reads and creates documents and files." },
  { name: "Image generation", description: "Generates images from a description." },
];
