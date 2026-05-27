/**
 * Deployment mode flag.
 *
 * `NOMOS_MODE=power_user` (default) — full feature surface; CLI + Settings UI
 * expose every knob (MCP config, plugins, raw model selection, bash tool,
 * BYO channel tokens, autonomous mode, file-based state).
 *
 * `NOMOS_MODE=hosted` — managed multi-customer deployment. The
 * **same feature set** as power-user with three exceptions:
 *   1. Integration credentials come via the central OAuth proxy only — no BYO.
 *   2. Channels are limited to what the central app supports (no iMessage,
 *      no BYO Slack bot token).
 *   3. Power-user knobs are hidden in the UI to keep the consumer surface
 *      simple. Underlying features (auto-dream, magic docs, smart routing,
 *      team mode, skills) all stay on.
 *
 * Plus: filesystem state is disallowed (see ensureEncryptionKey) and Redis
 * is required.
 */

export type NomosMode = "hosted" | "power_user";

export function getMode(): NomosMode {
  const raw = process.env.NOMOS_MODE?.trim().toLowerCase();
  if (raw === "hosted") return "hosted";
  return "power_user";
}

export function isHosted(): boolean {
  return getMode() === "hosted";
}

/**
 * Feature gates. Each predicate returns true iff the feature is permitted in
 * the current mode. UI surfaces, API handlers, and CLI commands should call
 * these instead of branching on `getMode()` directly so the list of
 * differences lives in one place.
 */
export const FEATURES = {
  /** User can configure their own MCP servers via .nomos/mcp.json. */
  byoMcp: (): boolean => !isHosted(),

  /** User can install/remove Claude marketplace plugins. */
  byoPlugins: (): boolean => !isHosted(),

  /** User can paste raw Slack bot tokens / Discord tokens / etc. */
  byoChannelTokens: (): boolean => !isHosted(),

  /** Skill loader looks at ~/.nomos/skills/ and ./skills/ beyond bundled set. */
  byoSkills: (): boolean => !isHosted(),

  /** Custom Anthropic API base URL (Ollama proxy, Bedrock, etc.). */
  customAnthropicBaseUrl: (): boolean => !isHosted(),

  /** Smart-routing model tier override knobs in the UI. Underlying feature stays on. */
  customModelTiers: (): boolean => !isHosted(),

  /** Bash tool exposed to the agent. Off in hosted mode — foot-cannon. */
  bashTool: (): boolean => !isHosted(),

  /** Autonomous mode (agent triggers itself without a user message). */
  autonomousMode: (): boolean => !isHosted(),

  /** iMessage channel — Mac-only, requires local `imsg` CLI. */
  iMessageChannel: (): boolean => !isHosted(),

  /** First-run terminal/web wizard at /setup. Replaced by mobile onboarding in hosted. */
  setupWizard: (): boolean => !isHosted(),

  /** /admin/* power-user pages in the Settings UI (database explorer, raw SQL, etc.). */
  adminPowerUserPages: (): boolean => !isHosted(),

  // Features that stay ON in both modes (declared explicitly so the contract is documented):
  autoDream: (): boolean => true,
  magicDocs: (): boolean => true,
  teamMode: (): boolean => true,
  memory: (): boolean => true,
  skills: (): boolean => true,
  smartRouting: (): boolean => true,
  draftManager: (): boolean => true,
};

/** Default per-platform consent mode when nothing is configured. */
export function defaultConsentMode(): "always_ask" | "auto_approve" | "notify_only" {
  return isHosted() ? "always_ask" : "always_ask";
}
