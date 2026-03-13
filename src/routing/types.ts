export interface RouteTarget {
  /** Which agent config to use */
  agentId: string;
  /** Optional model override */
  model?: string;
  /** Optional system prompt to append */
  systemPromptAppend?: string;
  /** Optional skills filter */
  skillsFilter?: string[];
}

export interface RouteMatch {
  /** Platform: "discord" | "slack" | "telegram" | "whatsapp" */
  platform?: string;
  /** Specific channel ID */
  channelId?: string;
  /** Discord guild ID */
  guildId?: string;
  /** Slack workspace/team ID */
  teamId?: string;
  /** Specific user ID */
  userId?: string;
  /** User role (for future use) */
  role?: string;
  /** Regex pattern to match message content */
  pattern?: string;
}

export interface RouteRule {
  /** Unique rule identifier */
  id: string;
  /** Rule priority (higher = first) */
  priority: number;
  /** Matching criteria (all optional, AND logic) */
  match: RouteMatch;
  /** Target agent configuration */
  target: RouteTarget;
  /** Whether this rule is enabled */
  enabled: boolean;
}
