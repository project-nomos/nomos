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
 *
 * Setting `AUTH_JWKS_URL` (JWT auth) also implies hosted, even without
 * `NOMOS_MODE=hosted`: once authenticated multi-tenant traffic is being served,
 * auth enforcement, feature gates, and per-user vault scoping must all agree
 * that we are hosted, otherwise authenticated users would collapse onto the
 * shared `local` vault.
 */

export type NomosMode = "hosted" | "power_user";

export function getMode(): NomosMode {
  const raw = process.env.NOMOS_MODE?.trim().toLowerCase();
  if (raw === "hosted") return "hosted";
  // JWT auth configured (AUTH_JWKS_URL) means we are serving authenticated,
  // multi-tenant traffic, so treat it as hosted even when NOMOS_MODE was not set
  // explicitly. This keeps auth enforcement (grpc-interceptor), feature gates,
  // and per-user vault scoping (resolveMemoryUserId) on ONE definition of
  // "hosted": a skew here would collapse authenticated users onto the shared
  // 'local' vault. Power-user installs never set AUTH_JWKS_URL, so they are
  // unaffected.
  if (process.env.AUTH_JWKS_URL) return "hosted";
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

  /**
   * Studio (hosted-only feature). The inverse of the BYO gates above:
   * the one feature that is OFF in power-user mode and ON in hosted, because it
   * depends on the hosted object-store + per-tenant Vertex credential.
   */
  studio: (): boolean => isHosted(),

  /**
   * Google Classroom (student assistant: read coursework/grades, draft + submit
   * homework via the approval flow, exam prep). Opt-in capability, OFF by default
   * in BOTH modes — not every user is a student. Toggled via the Extensions page
   * (persists `app.classroomEnabled`, mirrored to `NOMOS_CLASSROOM` so this sync
   * gate honors the DB flag — see loadEnvConfigAsync).
   */
  classroom: (): boolean => process.env.NOMOS_CLASSROOM === "true",

  /**
   * Allow turning in (submitting) approved Classroom homework drafts. A deployment
   * off-switch ON TOP of the per-account read-write scope: even if a connected
   * account granted `classroom.coursework.me`, the write tools (draft-submit/reclaim)
   * are withheld unless this is on. Default OFF — turn-in is the highest-trust action.
   * Mirrored from `app.classroomWriteEnabled` via loadEnvConfigAsync.
   */
  classroomWrite: (): boolean => process.env.NOMOS_CLASSROOM_WRITE === "true",

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
