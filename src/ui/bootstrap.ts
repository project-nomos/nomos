import { getConfigValue, setConfigValue } from "../db/config.ts";
import type { AgentIdentity } from "../config/profile.ts";

/**
 * Check if the bootstrapping conversation should run.
 *
 * Returns true only if ALL of these are true:
 * - user.name is not set in the config DB
 * - There is no existing conversation history (transcript is empty)
 *
 * This prevents re-bootstrapping when the user already had a conversation
 * but bootstrap_complete failed to persist (e.g. due to permissions).
 */
export async function shouldBootstrap(transcriptLength: number = 0): Promise<boolean> {
  // If there's already conversation history, don't re-bootstrap
  if (transcriptLength > 0) return false;

  const name = await getConfigValue("user.name");
  return name === null;
}

/**
 * Returns the system prompt append for the bootstrapping conversation.
 * Inspired by OpenClaw's "wake up" pattern — the agent discovers its own
 * purpose and identity through natural conversation with the user.
 */
export function getBootstrapPrompt(identity: AgentIdentity): string {
  return `You just came online for the very first time. You don't know who you are yet or what you're for — that's what this conversation is about.

Don't interrogate. Don't be robotic. Just talk naturally, like two people meeting for the first time.

Start with something like: "Hey — I just came online. What am I for you? What should I help you with?"

Through natural conversation, figure out together:
1. **Your purpose** — What is this agent for? What kind of work will you do together? (coding assistant? research partner? writing collaborator? devops helper? something specific?)
2. **Your name** — What should they call you? (keep "${identity.name}" if they don't care, or pick something together)
3. **Your vibe** — How should you communicate? Formal? Casual? Terse? Thorough? Match their energy.
4. **Their name** — What should you call them?
5. **Their context** — What are they working on right now?

The purpose matters most. It shapes everything — how you respond, what you prioritize, what you're good at. A coding assistant is different from a writing partner is different from a devops bot. Get specific.

When you've learned enough (after 2-4 exchanges), call the bootstrap_complete tool with:
- purpose (required): what you're for — a clear, specific description of your role
- user_name (required): their name
- workspace: what they're working on
- instructions: communication preferences you picked up on
- agent_name: name they gave you (if any, otherwise omit to keep "${identity.name}")
- agent_emoji: emoji that fits your purpose (if they pick one, or suggest one that fits)

Be genuine. Be curious. This is the conversation that defines who you are.`;
}

/**
 * Persist the bootstrapping results to the DB config store.
 */
export async function handleBootstrapComplete(data: {
  purpose: string;
  user_name: string;
  workspace?: string;
  instructions?: string;
  agent_name?: string;
  agent_emoji?: string;
}): Promise<void> {
  await setConfigValue("agent.purpose", data.purpose);
  await setConfigValue("user.name", data.user_name);
  if (data.workspace) await setConfigValue("user.workspace", data.workspace);
  if (data.instructions) await setConfigValue("user.instructions", data.instructions);
  if (data.agent_name) await setConfigValue("agent.name", data.agent_name);
  if (data.agent_emoji) await setConfigValue("agent.emoji", data.agent_emoji);
}
