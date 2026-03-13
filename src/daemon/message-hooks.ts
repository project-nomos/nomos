/**
 * Message transform hooks pipeline.
 *
 * Provides middleware-style transformIncoming and transformOutgoing hooks
 * that can modify messages as they flow through the channel manager.
 *
 * Hooks are loaded from:
 *   1. Programmatic registration via addHook()
 *   2. Auto-discovery from ~/.nomos/hooks/ directory (*.ts, *.js files)
 *
 * Each hook module should export:
 *   - name: string
 *   - transformIncoming?(message): message | Promise<message>
 *   - transformOutgoing?(message): message | Promise<message>
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { IncomingMessage, OutgoingMessage } from "./types.ts";

export interface MessageHook {
  /** Unique hook name for logging and debugging. */
  name: string;
  /** Priority: lower numbers run first (default: 100). */
  priority?: number;
  /** Platform filter: only run on these platforms (undefined = all). */
  platforms?: string[];
  /** Transform an incoming message before it reaches the agent. */
  transformIncoming?: (message: IncomingMessage) => IncomingMessage | Promise<IncomingMessage>;
  /** Transform an outgoing message before it's sent to the channel. */
  transformOutgoing?: (message: OutgoingMessage) => OutgoingMessage | Promise<OutgoingMessage>;
}

export class MessageHookPipeline {
  private hooks: MessageHook[] = [];
  private loaded = false;

  /** Register a hook programmatically. */
  addHook(hook: MessageHook): void {
    this.hooks.push(hook);
    this.sortHooks();
  }

  /** Remove a hook by name. */
  removeHook(name: string): void {
    this.hooks = this.hooks.filter((h) => h.name !== name);
  }

  /** List registered hooks. */
  listHooks(): Array<{ name: string; priority: number; platforms?: string[] }> {
    return this.hooks.map((h) => ({
      name: h.name,
      priority: h.priority ?? 100,
      platforms: h.platforms,
    }));
  }

  /**
   * Auto-discover and load hooks from ~/.nomos/hooks/ directory.
   * Safe to call multiple times (only loads once).
   */
  async loadHooksFromDisk(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    const hooksDir = path.join(os.homedir(), ".nomos", "hooks");
    if (!fs.existsSync(hooksDir)) return;

    const entries = fs.readdirSync(hooksDir);
    for (const entry of entries) {
      if (!entry.endsWith(".ts") && !entry.endsWith(".js")) continue;
      const hookPath = path.join(hooksDir, entry);

      try {
        const mod = await import(hookPath);
        const hook: MessageHook = {
          name: mod.name ?? path.basename(entry, path.extname(entry)),
          priority: mod.priority ?? 100,
          platforms: mod.platforms,
          transformIncoming: mod.transformIncoming,
          transformOutgoing: mod.transformOutgoing,
        };

        if (!hook.transformIncoming && !hook.transformOutgoing) {
          console.warn(
            `[hooks] Skipping ${entry}: no transformIncoming or transformOutgoing exported`,
          );
          continue;
        }

        this.hooks.push(hook);
        console.log(`[hooks] Loaded: ${hook.name} (priority: ${hook.priority})`);
      } catch (err) {
        console.error(`[hooks] Failed to load ${entry}:`, err);
      }
    }

    this.sortHooks();
  }

  /**
   * Run all incoming hooks on a message.
   * Returns the transformed message (or original if no hooks match).
   */
  async transformIncoming(message: IncomingMessage): Promise<IncomingMessage> {
    let result = message;

    for (const hook of this.hooks) {
      if (!hook.transformIncoming) continue;
      if (hook.platforms && !hook.platforms.includes(message.platform)) continue;

      try {
        result = await hook.transformIncoming(result);
      } catch (err) {
        console.error(`[hooks] ${hook.name}.transformIncoming failed:`, err);
        // Continue with the unmodified message on error
      }
    }

    return result;
  }

  /**
   * Run all outgoing hooks on a message.
   * Returns the transformed message (or original if no hooks match).
   */
  async transformOutgoing(message: OutgoingMessage): Promise<OutgoingMessage> {
    let result = message;

    for (const hook of this.hooks) {
      if (!hook.transformOutgoing) continue;
      if (hook.platforms && !hook.platforms.includes(message.platform)) continue;

      try {
        result = await hook.transformOutgoing(result);
      } catch (err) {
        console.error(`[hooks] ${hook.name}.transformOutgoing failed:`, err);
      }
    }

    return result;
  }

  private sortHooks(): void {
    this.hooks.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }
}
