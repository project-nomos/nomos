/**
 * Channel manager: registers and manages the lifecycle of channel adapters.
 * Integrates the message hook pipeline for incoming/outgoing transforms.
 */

import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "./types.ts";
import { MessageHookPipeline, type MessageHook } from "./message-hooks.ts";

export class ChannelManager {
  private adapters = new Map<string, ChannelAdapter>();
  private started = false;
  readonly hooks = new MessageHookPipeline();

  /** Register a channel adapter. Must be called before start(). */
  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.platform)) {
      throw new Error(`Adapter for platform "${adapter.platform}" already registered`);
    }
    this.adapters.set(adapter.platform, adapter);
  }

  /** Register a message transform hook. */
  addHook(hook: MessageHook): void {
    this.hooks.addHook(hook);
  }

  /** Start all registered adapters and load hooks from disk. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Load user-defined hooks from ~/.nomos/hooks/
    await this.hooks.loadHooksFromDisk();

    const hookList = this.hooks.listHooks();
    if (hookList.length > 0) {
      console.log(`[channel-manager] Loaded ${hookList.length} message hook(s)`);
    }

    // Group adapters by rate-limit domain (platform prefix before ":").
    // Adapters in the same group start sequentially to avoid rate limits;
    // different groups start concurrently.
    const groups = new Map<string, ChannelAdapter[]>();
    for (const adapter of this.adapters.values()) {
      const domain = adapter.platform.split(":")[0];
      const list = groups.get(domain) ?? [];
      list.push(adapter);
      groups.set(domain, list);
    }

    // Stagger delay between sequential adapter starts within a group
    // to avoid slamming shared rate limits (e.g. Slack Tier 3: 50 req/min).
    const STAGGER_DELAY_MS = 5000;

    const results = await Promise.allSettled(
      [...groups.values()].map(async (adapters) => {
        for (let i = 0; i < adapters.length; i++) {
          const adapter = adapters[i];
          if (i > 0) {
            await new Promise((resolve) => setTimeout(resolve, STAGGER_DELAY_MS));
          }
          try {
            await adapter.start();
            console.log(`[channel-manager] Started: ${adapter.platform}`);
          } catch (err) {
            console.error(`[channel-manager] Failed to start ${adapter.platform}:`, err);
          }
        }
      }),
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      console.warn(
        `[channel-manager] ${failures.length}/${this.adapters.size} adapter group(s) failed to start`,
      );
    }
  }

  /** Stop all adapters gracefully. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    await Promise.allSettled(
      [...this.adapters.values()].map(async (adapter) => {
        try {
          await adapter.stop();
          console.log(`[channel-manager] Stopped: ${adapter.platform}`);
        } catch (err) {
          console.error(`[channel-manager] Error stopping ${adapter.platform}:`, err);
        }
      }),
    );
  }

  /**
   * Transform an incoming message through the hook pipeline.
   * Called by the gateway before enqueuing.
   */
  async transformIncoming(message: IncomingMessage): Promise<IncomingMessage> {
    return this.hooks.transformIncoming(message);
  }

  /**
   * Send a message back through the appropriate channel adapter.
   * Runs outgoing hooks before delivery.
   */
  async send(message: OutgoingMessage): Promise<void> {
    // Run outgoing transform hooks
    const transformed = await this.hooks.transformOutgoing(message);

    const adapter = this.adapters.get(transformed.platform);
    if (!adapter) {
      console.warn(`[channel-manager] No adapter for platform "${transformed.platform}"`);
      return;
    }
    await adapter.send(transformed);
  }

  /** Register and start a new adapter at runtime (hot-reload). */
  async registerAndStart(adapter: ChannelAdapter): Promise<void> {
    // Stop and remove existing adapter for this platform if present
    const existing = this.adapters.get(adapter.platform);
    if (existing) {
      try {
        await existing.stop();
      } catch {
        // Ignore stop errors on old adapter
      }
      this.adapters.delete(adapter.platform);
    }

    this.adapters.set(adapter.platform, adapter);
    try {
      await adapter.start();
      console.log(`[channel-manager] Hot-loaded: ${adapter.platform}`);
    } catch (err) {
      console.error(`[channel-manager] Failed to hot-load ${adapter.platform}:`, err);
      this.adapters.delete(adapter.platform);
    }
  }

  /** Stop and remove an adapter by platform name. */
  async removeAdapter(platform: string): Promise<boolean> {
    const adapter = this.adapters.get(platform);
    if (!adapter) return false;
    try {
      await adapter.stop();
      console.log(`[channel-manager] Removed: ${platform}`);
    } catch {
      // Ignore stop errors
    }
    this.adapters.delete(platform);
    return true;
  }

  /** Check if an adapter is registered for the given platform. */
  hasAdapter(platform: string): boolean {
    return this.adapters.has(platform);
  }

  /** Look up a registered adapter by platform name. */
  getAdapter(platform: string): ChannelAdapter | undefined {
    return this.adapters.get(platform);
  }

  /** List registered platform names. */
  listPlatforms(): string[] {
    return [...this.adapters.keys()];
  }
}
