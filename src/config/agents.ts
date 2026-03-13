import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface AgentConfig {
  id: string;
  name: string;
  model?: string;
  workspace?: string;
  skills?: string[];
  thinkingLevel?: string;
  systemPrompt?: string;
}

interface AgentsFile {
  agents: AgentConfig[];
}

const DEFAULT_AGENT: AgentConfig = { id: "default", name: "Default" };

export function loadAgentConfigs(): AgentConfig[] {
  const paths = [
    path.join(process.cwd(), ".nomos", "agents.json"),
    path.join(os.homedir(), ".nomos", "agents.json"),
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, "utf-8");
        const parsed: AgentsFile = JSON.parse(raw);
        if (Array.isArray(parsed.agents) && parsed.agents.length > 0) {
          return parsed.agents;
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  return [DEFAULT_AGENT];
}

export function getActiveAgent(agents: AgentConfig[], agentId?: string): AgentConfig {
  if (agentId) {
    const found = agents.find((a) => a.id === agentId);
    if (found) return found;
  }
  return agents[0] ?? DEFAULT_AGENT;
}
