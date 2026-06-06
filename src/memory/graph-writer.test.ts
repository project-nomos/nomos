import { vi, describe, it, expect, beforeEach } from "vitest";
import { createMockDb } from "../db/test-helpers.ts";

const { db, addResult, getQueries, reset } = createMockDb();
vi.mock("../db/client.ts", () => ({ getKysely: () => db }));

import {
  classifyEntity,
  detectRelType,
  parseWikiLinks,
  ingestKnowledgeIntoGraph,
} from "./graph-writer.ts";
import type { ExtractedKnowledge } from "./extractor.ts";
import type { TenantContext } from "../auth/tenant-context.ts";

const T: TenantContext = { orgId: "o", userId: "u1" };
const empty: ExtractedKnowledge = {
  facts: [],
  preferences: [],
  corrections: [],
  decisionPatterns: [],
  values: [],
};

beforeEach(() => reset());

describe("classifyEntity", () => {
  it("keeps proper names as nodes", () => {
    expect(classifyEntity("Alice Chen")).toEqual({ keep: true, isAttribute: false });
    expect(classifyEntity("Acme Corp")).toEqual({ keep: true, isAttribute: false });
  });
  it("folds contact details as attributes", () => {
    expect(classifyEntity("(415) 418-4370")).toEqual({
      keep: true,
      isAttribute: true,
      attribute: "phone",
    });
    expect(classifyEntity("sophie@example.com")).toEqual({
      keep: true,
      isAttribute: true,
      attribute: "email",
    });
    expect(classifyEntity("https://acme.com")).toEqual({
      keep: true,
      isAttribute: true,
      attribute: "url",
    });
  });
  it("drops noise, pure numbers, dates, and stubs", () => {
    expect(classifyEntity("the user").keep).toBe(false);
    expect(classifyEntity("42").keep).toBe(false);
    expect(classifyEntity("2026-06-01").keep).toBe(false);
    expect(classifyEntity("x").keep).toBe(false);
  });
});

describe("detectRelType", () => {
  it("maps verb patterns to relation types", () => {
    expect(detectRelType("Alice works at Acme")).toBe("works_at");
    expect(detectRelType("Bob is a member of the board")).toBe("member_of");
    expect(detectRelType("Carol founded the startup")).toBe("founded");
    expect(detectRelType("met with Dave yesterday")).toBe("scheduled_with");
    expect(detectRelType("Eve lives in Berlin")).toBe("located_in");
  });
  it("falls back to related_to", () => {
    expect(detectRelType("Alice and Bob are connected somehow")).toBe("related_to");
  });
});

describe("parseWikiLinks", () => {
  it("extracts targets, strips aliases + heading anchors, dedupes", () => {
    const links = parseWikiLinks(
      "See [[Alice]], [[Project Nomos|the project]] and [[Alice]] again, [[Topic#Section]].",
    );
    expect(links).toEqual(["Alice", "Project Nomos", "Topic"]);
  });
  it("returns empty for no links", () => {
    expect(parseWikiLinks("plain text")).toEqual([]);
  });
});

describe("ingestKnowledgeIntoGraph", () => {
  it("rejects low-confidence facts without writing", async () => {
    const k = { ...empty, facts: [{ text: "weak", entities: ["X Co"], confidence: 0.3 }] };
    const r = await ingestKnowledgeIntoGraph(T, k);
    expect(r.nodesUpserted).toBe(0);
    expect(r.rejected).toBe(1);
    expect(getQueries()).toHaveLength(0);
  });

  it("creates two nodes + a typed edge for a relationship fact", async () => {
    // resolveEntityNode(Alice): contacts SELECT [], upsertNode -> id
    addResult([]); // contact lookup (Alice) — none
    addResult([{ id: "n-alice" }]); // upsert Alice
    addResult([]); // contact lookup (Acme) — none
    addResult([{ id: "n-acme" }]); // upsert Acme
    addResult([{ id: "e1" }]); // upsert edge

    const k = {
      ...empty,
      facts: [{ text: "Alice works at Acme", entities: ["Alice", "Acme"], confidence: 0.9 }],
    };
    const r = await ingestKnowledgeIntoGraph(T, k);
    expect(r.nodesUpserted).toBe(2);
    expect(r.edgesUpserted).toBe(1);

    const sqls = getQueries().map((q) => q.sql.toLowerCase());
    expect(sqls.some((s) => s.includes("insert into") && s.includes("kg_edges"))).toBe(true);
    // The verb-pattern relation type is bound as a parameter on the edge insert.
    const edgeQ = getQueries().find((q) => q.sql.toLowerCase().includes("kg_edges"));
    expect(edgeQ?.parameters).toContain("works_at");
    expect(edgeQ?.parameters).toContain("u1");
  });

  it("folds a phone number as an attribute (no second node, no edge)", async () => {
    addResult([]); // contact lookup (Sophie) — none
    addResult([{ id: "n-soph" }]); // upsert Sophie
    addResult([]); // mergeNodeAttrs UPDATE

    const k = {
      ...empty,
      facts: [
        {
          text: "Sophie's phone number is (415) 418-4370",
          entities: ["Sophie", "(415) 418-4370"],
          confidence: 0.95,
        },
      ],
    };
    const r = await ingestKnowledgeIntoGraph(T, k);
    expect(r.nodesUpserted).toBe(1);
    expect(r.edgesUpserted).toBe(0);
    const sqls = getQueries().map((q) => q.sql.toLowerCase());
    expect(sqls.some((s) => s.includes("update") && s.includes("kg_nodes"))).toBe(true);
  });
});
