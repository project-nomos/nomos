import type { RouteRule, RouteTarget } from "./types.ts";

export interface RouteContext {
  /** Platform identifier */
  platform: string;
  /** Channel ID */
  channelId: string;
  /** Optional Discord guild ID */
  guildId?: string;
  /** Optional Slack team/workspace ID */
  teamId?: string;
  /** User ID */
  userId: string;
  /** Optional message text for pattern matching */
  messageText?: string;
}

export class AgentRouter {
  private rules: RouteRule[];

  constructor(rules: RouteRule[]) {
    // Sort rules by priority (higher = first)
    this.rules = [...rules].sort((a, b) => b.priority - a.priority);
  }

  /**
   * Find the first matching rule for the given context.
   * Returns the target configuration or null if no match.
   */
  resolve(context: RouteContext): RouteTarget | null {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      if (this.matches(rule, context)) {
        return rule.target;
      }
    }
    return null;
  }

  /**
   * Add a new rule and re-sort by priority.
   */
  addRule(rule: RouteRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Remove a rule by ID.
   */
  removeRule(id: string): void {
    this.rules = this.rules.filter((r) => r.id !== id);
  }

  /**
   * List all rules (sorted by priority).
   */
  listRules(): RouteRule[] {
    return [...this.rules];
  }

  /**
   * Check if a rule matches the context (AND logic for all specified fields).
   */
  private matches(rule: RouteRule, context: RouteContext): boolean {
    const { match } = rule;

    // Platform match
    if (match.platform && match.platform !== context.platform) {
      return false;
    }

    // Channel ID match
    if (match.channelId && match.channelId !== context.channelId) {
      return false;
    }

    // Guild ID match
    if (match.guildId && match.guildId !== context.guildId) {
      return false;
    }

    // Team ID match
    if (match.teamId && match.teamId !== context.teamId) {
      return false;
    }

    // User ID match
    if (match.userId && match.userId !== context.userId) {
      return false;
    }

    // Role match (for future use, currently always passes)
    if (match.role) {
      // TODO: Implement role matching when user role system is available
      return false;
    }

    // Pattern match
    if (match.pattern && context.messageText) {
      try {
        const regex = new RegExp(match.pattern);
        if (!regex.test(context.messageText)) {
          return false;
        }
      } catch {
        // Invalid regex pattern, treat as no match
        return false;
      }
    } else if (match.pattern && !context.messageText) {
      // Pattern specified but no message text provided
      return false;
    }

    // All criteria matched (AND logic)
    return true;
  }
}
