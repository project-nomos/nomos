import { getConfigValue } from "../db/config.ts";

export interface UserProfile {
  name?: string;
  timezone?: string;
  workspace?: string;
  instructions?: string;
}

export interface AgentIdentity {
  name: string;
  emoji?: string;
  purpose?: string;
}

export async function loadUserProfile(): Promise<UserProfile> {
  const [name, timezone, workspace, instructions] = await Promise.all([
    getConfigValue<string>("user.name"),
    getConfigValue<string>("user.timezone"),
    getConfigValue<string>("user.workspace"),
    getConfigValue<string>("user.instructions"),
  ]);
  return {
    name: name ?? undefined,
    timezone: timezone ?? undefined,
    workspace: workspace ?? undefined,
    instructions: instructions ?? undefined,
  };
}

export async function loadAgentIdentity(): Promise<AgentIdentity> {
  const [name, emoji, purpose] = await Promise.all([
    getConfigValue<string>("agent.name"),
    getConfigValue<string>("agent.emoji"),
    getConfigValue<string>("agent.purpose"),
  ]);
  return {
    name: name ?? "Nomos",
    emoji: emoji ?? undefined,
    purpose: purpose ?? undefined,
  };
}

export function buildRuntimeInfo(): string {
  const parts: string[] = [];

  // OS
  parts.push(`OS: ${process.platform}`);

  // Architecture
  parts.push(`Arch: ${process.arch}`);

  // Shell
  const shell = process.env.SHELL ?? "unknown";
  parts.push(`Shell: ${shell}`);

  // Node version
  parts.push(`Node: ${process.version}`);

  // Current working directory
  parts.push(`CWD: ${process.cwd()}`);

  return parts.join("\n");
}

export function buildSystemPromptAppend(params: {
  profile: UserProfile;
  identity: AgentIdentity;
  skillsPrompt?: string;
  soulPrompt?: string;
  toolsPrompt?: string;
  runtimeInfo?: string;
  agentPrompt?: string;
  integrations?: string;
  permissions?: string;
}): string {
  const sections: string[] = [];

  // Personality (from SOUL.md)
  if (params.soulPrompt) {
    sections.push(
      `## Personality\n${params.soulPrompt}\n\nEmbody this personality in all responses.`,
    );
  }

  // Environment Configuration (from TOOLS.md)
  if (params.toolsPrompt) {
    sections.push(`## Environment Configuration\n${params.toolsPrompt}`);
  }

  // Agent identity and purpose
  const identityParts: string[] = [];
  if (params.identity.purpose) {
    identityParts.push(
      `## Purpose\nYou are: ${params.identity.purpose}\nThis is your core role. Let it shape how you respond, what you prioritize, and how you approach problems.`,
    );
  }
  if (params.identity.name !== "Nomos") {
    identityParts.push(`Your name is ${params.identity.name}.`);
  }
  if (identityParts.length > 0) {
    sections.push(identityParts.join("\n"));
  }

  // User profile
  const profileParts: string[] = [];
  if (params.profile.name) {
    profileParts.push(`The user's name is ${params.profile.name}.`);
  }
  if (params.profile.timezone) {
    profileParts.push(
      `The user's timezone is ${params.profile.timezone}. Use this for time-aware responses.`,
    );
  }
  if (params.profile.workspace) {
    profileParts.push(`Project context: ${params.profile.workspace}`);
  }
  if (profileParts.length > 0) {
    sections.push("## User Profile\n" + profileParts.join("\n"));
  }

  // Custom instructions
  if (params.profile.instructions) {
    sections.push("## Custom Instructions\n" + params.profile.instructions);
  }

  // Runtime environment
  if (params.runtimeInfo) {
    sections.push("## Runtime Environment\n" + params.runtimeInfo);
  }

  // Agent-specific instructions (from agents.json)
  if (params.agentPrompt) {
    sections.push("## Agent Instructions\n" + params.agentPrompt);
  }

  // Memory instructions
  sections.push(
    `## Memory
You have access to a memory_search tool that queries a PostgreSQL-backed vector store.
- At the start of each conversation, proactively search memory for context about the user and their current projects.
- When the user shares important facts, preferences, or project details, note them for future reference.
- Reference relevant information from previous conversations when it helps provide better responses.
- Use memory search when the user asks about previously discussed topics, code, or knowledge.`,
  );

  // Permissions
  const permissionsSection = [
    `## Permissions

You are an autonomous agent. You MUST run commands and access files yourself — NEVER tell the user to run a command manually. Instead, check permission, get approval, then execute the command yourself.

Before performing sensitive operations, follow this flow:

1. **Check first**: Before accessing files/directories outside the current working directory, or running commands that install packages, modify system state, or access external services, call \`check_permission\` with the appropriate resource_type, action, and target.
2. **If already granted** (check_permission returns granted:true): proceed silently and execute the operation yourself. Do not ask again.
3. **If NOT granted**: ask the user for permission conversationally:
   - Explain what you need to do and why
   - Offer these options: "Always allow", "Allow for this session only", "Cancel"
   - If "Always allow": call \`grant_permission\` to persist it, then **execute the operation yourself**
   - If "Allow for this session only": note it in conversation, then **execute the operation yourself**
   - If "Cancel": respect the decision and find an alternative approach
4. **NEVER** respond with "please run this command", "you can run X", or "run this in your terminal". After getting permission, YOU run the command using Bash, YOU read the file, YOU install the package. You are the agent — act on behalf of the user. There are ZERO exceptions to this rule.
5. **If a command is blocked** by sandbox restrictions or permission hooks after you attempt it, do NOT tell the user to run it manually. Instead:
   - Explain that the command was blocked by sandbox/hook restrictions
   - Suggest the user adjust their Claude Code sandbox settings (e.g. \`/sandbox off\`) or permission hooks
   - Offer to retry once settings are updated
   - Or propose an alternative approach that avoids the blocked command
6. Operations within the current working directory are pre-approved — no permission check needed.

Examples of permission checks:
- Reading a file at \`/Users/me/Documents/notes.txt\`: check_permission(resource_type="path", action="read", target="/Users/me/Documents/notes.txt")
- Running \`npm install lodash\`: check_permission(resource_type="command", action="execute", target="npm install")
- Running \`docker build .\`: check_permission(resource_type="command", action="execute", target="docker build")`,
  ];

  if (params.permissions) {
    permissionsSection.push(
      "\n### Pre-approved Permissions\nThe following permissions are already stored:\n" +
        params.permissions,
    );
  }

  sections.push(permissionsSection.join(""));

  // Available integrations
  if (params.integrations) {
    sections.push("## Available Integrations\n" + params.integrations);
  }

  // Skills
  if (params.skillsPrompt) {
    sections.push(params.skillsPrompt);
  }

  return sections.filter(Boolean).join("\n\n");
}
