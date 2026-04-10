import { getKysely } from "./client.ts";

export interface AgentPermission {
  id: string;
  resource_type: string;
  action: string;
  pattern: string;
  granted_by: string | null;
  created_at: Date;
}

/** Upsert a permission rule (idempotent). */
export async function grantPermission(
  resourceType: string,
  action: string,
  pattern: string,
  grantedBy?: string,
): Promise<void> {
  const db = getKysely();
  await db
    .insertInto("agent_permissions")
    .values({
      resource_type: resourceType,
      action,
      pattern,
      granted_by: grantedBy ?? null,
    })
    .onConflict((oc) =>
      oc.columns(["resource_type", "action", "pattern"]).doUpdateSet({
        granted_by: grantedBy ?? null,
        created_at: new Date(),
      }),
    )
    .execute();
}

/** Remove a specific permission rule. */
export async function revokePermission(
  resourceType: string,
  action: string,
  pattern: string,
): Promise<boolean> {
  const db = getKysely();
  const result = await db
    .deleteFrom("agent_permissions")
    .where("resource_type", "=", resourceType)
    .where("action", "=", action)
    .where("pattern", "=", pattern)
    .executeTakeFirst();
  return (result.numDeletedRows ?? 0n) > 0n;
}

/**
 * Check if a target matches any stored permission.
 * Supports exact match and glob patterns with trailing `*`.
 */
export async function checkPermission(
  resourceType: string,
  action: string,
  target: string,
): Promise<{ granted: boolean; pattern?: string }> {
  const db = getKysely();
  const rows = await db
    .selectFrom("agent_permissions")
    .select("pattern")
    .where("resource_type", "=", resourceType)
    .where("action", "=", action)
    .execute();

  for (const row of rows) {
    if (matchPattern(row.pattern, target)) {
      return { granted: true, pattern: row.pattern };
    }
  }

  return { granted: false };
}

/** List all stored permissions, optionally filtered by resource type. */
export async function listPermissions(resourceType?: string): Promise<AgentPermission[]> {
  const db = getKysely();
  let query = db
    .selectFrom("agent_permissions")
    .select(["id", "resource_type", "action", "pattern", "granted_by", "created_at"])
    .orderBy("resource_type")
    .orderBy("action")
    .orderBy("pattern");

  if (resourceType) {
    query = query.where("resource_type", "=", resourceType);
  }

  return query.execute();
}

/** Delete all stored permissions. */
export async function clearAllPermissions(): Promise<number> {
  const db = getKysely();
  const result = await db.deleteFrom("agent_permissions").executeTakeFirst();
  return Number(result.numDeletedRows ?? 0n);
}

/**
 * Match a pattern against a target string.
 * - Exact match: `npm install` matches `npm install`
 * - Trailing glob: `/Users/meidad/Documents/*` matches any path under that directory
 */
function matchPattern(pattern: string, target: string): boolean {
  if (pattern === target) return true;

  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return target.startsWith(prefix);
  }

  return false;
}
