import { vi, describe, it, expect, beforeEach } from "vitest";
import { createMockDb } from "../db/test-helpers.ts";

const { db, addResult, getQueries, reset } = createMockDb();
vi.mock("../db/client.ts", () => ({ getKysely: () => db }));

import {
  upsertNode,
  upsertEdge,
  neighborhood,
  shortestPath,
  getProjection,
  searchNodes,
  normalizeKey,
  NIL_NODE,
  NODE_KINDS,
  REL_TYPES,
} from "./graph.ts";
import type { TenantContext } from "../auth/tenant-context.ts";

const ALICE: TenantContext = { orgId: "org1", userId: "user-alice" };

beforeEach(() => reset());

describe("normalizeKey", () => {
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normalizeKey("  Acme   Corp ")).toBe("acme corp");
  });
});

describe("constants", () => {
  it("exposes the starting taxonomies", () => {
    expect(NODE_KINDS).toContain("person");
    expect(REL_TYPES).toContain("works_at");
    expect(NIL_NODE).toMatch(/^0{8}-0{4}-0{4}-0{4}-0{12}$/);
  });
});

describe("upsertNode", () => {
  it("inserts with ON CONFLICT on (user_id, kind, canonical_key) and returns id", async () => {
    addResult([{ id: "node-1" }]);
    const id = await upsertNode(ALICE, { kind: "person", name: "Alice" });
    expect(id).toBe("node-1");

    const q = getQueries()[0];
    expect(q.sql).toContain("kg_nodes");
    expect(q.sql.toLowerCase()).toContain("on conflict");
    // canonical_key defaults to normalized name; user_id threads from ctx.
    expect(q.parameters).toContain("alice");
    expect(q.parameters).toContain("user-alice");
  });
});

describe("upsertEdge", () => {
  it("inserts with the nil origin_node sentinel by default", async () => {
    addResult([{ id: "edge-1" }]);
    const id = await upsertEdge(ALICE, { srcId: "a", dstId: "b", relType: "works_at" });
    expect(id).toBe("edge-1");
    const q = getQueries()[0];
    expect(q.parameters).toContain(NIL_NODE);
    expect(q.parameters).toContain("user-alice");
  });
});

describe("neighborhood — tenant isolation", () => {
  it("filters user_id at EVERY hop of the recursive walk", async () => {
    addResult([{ id: "a" }, { id: "b" }]); // reach
    addResult([
      {
        id: "a",
        kind: "person",
        name: "Alice",
        canonical_key: "alice",
        aliases: [],
        summary: null,
        external_kind: null,
        external_ref: null,
        attrs: {},
        confidence: 0.9,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]); // nodes
    addResult([]); // edges

    await neighborhood(ALICE, "a", { depth: 3 });

    const reachQuery = getQueries()[0];
    // The recursive CTE must reference user_id in BOTH the base and the join.
    const occurrences = (reachQuery.sql.match(/user_id/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    // And the userId must be a bound parameter (never interpolated/another user).
    expect(reachQuery.parameters).toContain("user-alice");
  });

  it("scopes the node and edge fetches to the same user", async () => {
    addResult([{ id: "a" }]); // reach
    addResult([]); // nodes
    addResult([]); // edges
    await neighborhood(ALICE, "a");
    for (const q of getQueries()) {
      expect(q.parameters).toContain("user-alice");
    }
  });

  it("returns empty when the start node has no reachable set", async () => {
    addResult([]); // reach empty
    const sub = await neighborhood(ALICE, "missing");
    expect(sub).toEqual({ nodes: [], edges: [] });
    // No follow-up node/edge queries when reach is empty.
    expect(getQueries()).toHaveLength(1);
  });

  it("caps depth at MAX_DEPTH", async () => {
    addResult([{ id: "a" }]);
    addResult([]);
    addResult([]);
    await neighborhood(ALICE, "a", { depth: 99 });
    // depth bound is a parameter; 99 must be clamped to 3.
    expect(getQueries()[0].parameters).toContain(3);
    expect(getQueries()[0].parameters).not.toContain(99);
  });
});

describe("shortestPath", () => {
  it("returns null when no path exists", async () => {
    addResult([]); // walk finds nothing
    const path = await shortestPath(ALICE, "a", "z");
    expect(path).toBeNull();
  });

  it("hydrates nodes and edges along the found path", async () => {
    addResult([{ npath: ["a", "b"], epath: ["e1"] }]); // walk
    addResult([
      {
        id: "a",
        kind: "person",
        name: "A",
        canonical_key: "a",
        aliases: [],
        summary: null,
        external_kind: null,
        external_ref: null,
        attrs: {},
        confidence: 0.5,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: "b",
        kind: "person",
        name: "B",
        canonical_key: "b",
        aliases: [],
        summary: null,
        external_kind: null,
        external_ref: null,
        attrs: {},
        confidence: 0.5,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]); // nodes
    addResult([
      {
        id: "e1",
        src_id: "a",
        dst_id: "b",
        rel_type: "works_at",
        fact: null,
        origin: "explicit",
        weight: 1,
        valid_at: new Date(),
        invalid_at: null,
        confidence: 0.5,
        attrs: {},
      },
    ]); // edges
    const path = await shortestPath(ALICE, "a", "b");
    expect(path?.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(path?.edges[0]?.relType).toBe("works_at");
  });
});

describe("getProjection", () => {
  it("returns nodes and the edges among them, user-scoped", async () => {
    addResult([
      {
        id: "a",
        kind: "person",
        name: "A",
        canonical_key: "a",
        aliases: [],
        summary: null,
        external_kind: null,
        external_ref: null,
        attrs: {},
        confidence: 0.5,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]); // nodes
    addResult([]); // edges
    const sub = await getProjection(ALICE, { limit: 100 });
    expect(sub.nodes).toHaveLength(1);
    for (const q of getQueries()) expect(q.parameters).toContain("user-alice");
  });
});

describe("searchNodes", () => {
  it("filters by user and uses trigram similarity", async () => {
    addResult([]);
    await searchNodes(ALICE, "acme");
    const q = getQueries()[0];
    expect(q.sql.toLowerCase()).toContain("similarity");
    expect(q.parameters).toContain("user-alice");
    expect(q.parameters).toContain("acme");
  });
});
