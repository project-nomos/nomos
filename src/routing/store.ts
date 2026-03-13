import { getDb } from "../db/client.ts";
import type { RouteRule } from "./types.ts";

export class RouteStore {
  private tableName = "routing_rules";

  async init(): Promise<void> {
    const db = getDb();
    await db`
      CREATE TABLE IF NOT EXISTS ${db(this.tableName)} (
        id TEXT PRIMARY KEY,
        priority INTEGER NOT NULL,
        match JSONB NOT NULL,
        target JSONB NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
  }

  async loadRules(): Promise<RouteRule[]> {
    const db = getDb();
    const rows = await db`
      SELECT id, priority, match, target, enabled
      FROM ${db(this.tableName)}
      ORDER BY priority DESC
    `;

    return rows.map((row) => ({
      id: row.id,
      priority: row.priority,
      match: row.match,
      target: row.target,
      enabled: row.enabled,
    }));
  }

  async saveRule(rule: RouteRule): Promise<void> {
    const db = getDb();
    await db`
      INSERT INTO ${db(this.tableName)} (id, priority, match, target, enabled, updated_at)
      VALUES (
        ${rule.id},
        ${rule.priority},
        ${JSON.stringify(rule.match)},
        ${JSON.stringify(rule.target)},
        ${rule.enabled},
        NOW()
      )
      ON CONFLICT (id)
      DO UPDATE SET
        priority = EXCLUDED.priority,
        match = EXCLUDED.match,
        target = EXCLUDED.target,
        enabled = EXCLUDED.enabled,
        updated_at = NOW()
    `;
  }

  async deleteRule(id: string): Promise<void> {
    const db = getDb();
    await db`
      DELETE FROM ${db(this.tableName)}
      WHERE id = ${id}
    `;
  }
}
