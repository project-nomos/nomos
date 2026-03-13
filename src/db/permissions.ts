import { getDb } from "./client.ts";

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
  const sql = getDb();
  await sql`
    INSERT INTO agent_permissions (resource_type, action, pattern, granted_by)
    VALUES (${resourceType}, ${action}, ${pattern}, ${grantedBy ?? null})
    ON CONFLICT (resource_type, action, pattern) DO UPDATE SET
      granted_by = ${grantedBy ?? null},
      created_at = now()
  `;
}

/** Remove a specific permission rule. */
export async function revokePermission(
  resourceType: string,
  action: string,
  pattern: string,
): Promise<boolean> {
  const sql = getDb();
  const result = await sql`
    DELETE FROM agent_permissions
    WHERE resource_type = ${resourceType}
      AND action = ${action}
      AND pattern = ${pattern}
  `;
  return result.count > 0;
}

/**
 * Check if a target matches any stored permission.
 * Supports exact match and glob patterns with trailing `*`.
 * E.g. pattern `/Users/meidad/Documents/*` matches `/Users/meidad/Documents/foo.txt`.
 */
export async function checkPermission(
  resourceType: string,
  action: string,
  target: string,
): Promise<{ granted: boolean; pattern?: string }> {
  const sql = getDb();
  const rows = await sql<Array<{ pattern: string }>>`
    SELECT pattern FROM agent_permissions
    WHERE resource_type = ${resourceType} AND action = ${action}
  `;

  for (const row of rows) {
    if (matchPattern(row.pattern, target)) {
      return { granted: true, pattern: row.pattern };
    }
  }

  return { granted: false };
}

/** List all stored permissions, optionally filtered by resource type. */
export async function listPermissions(resourceType?: string): Promise<AgentPermission[]> {
  const sql = getDb();
  if (resourceType) {
    return sql<AgentPermission[]>`
      SELECT id, resource_type, action, pattern, granted_by, created_at
      FROM agent_permissions
      WHERE resource_type = ${resourceType}
      ORDER BY resource_type, action, pattern
    `;
  }
  return sql<AgentPermission[]>`
    SELECT id, resource_type, action, pattern, granted_by, created_at
    FROM agent_permissions
    ORDER BY resource_type, action, pattern
  `;
}

/** Delete all stored permissions. */
export async function clearAllPermissions(): Promise<number> {
  const sql = getDb();
  const result = await sql`DELETE FROM agent_permissions`;
  return result.count;
}

/**
 * Match a pattern against a target string.
 * - Exact match: `npm install` matches `npm install`
 * - Trailing glob: `/Users/meidad/Documents/*` matches any path under that directory
 * - Trailing glob: `docker *` matches `docker run`, `docker build`, etc.
 */
function matchPattern(pattern: string, target: string): boolean {
  if (pattern === target) return true;

  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return target.startsWith(prefix);
  }

  return false;
}
