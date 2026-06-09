import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/wiki.ts", () => ({
  searchArticles: vi.fn(),
  getArticle: vi.fn(),
  listArticles: vi.fn(),
}));

import { searchArticles } from "../db/wiki.ts";
import { getRelevantArticles } from "./wiki-reader.ts";

const search = searchArticles as unknown as ReturnType<typeof vi.fn>;

describe("getRelevantArticles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns '' for an empty query without hitting the DB", async () => {
    expect(await getRelevantArticles("local", "")).toBe("");
    expect(search).not.toHaveBeenCalled();
  });

  it("returns '' when there are no matches", async () => {
    search.mockResolvedValue([]);
    expect(await getRelevantArticles("local", "anything")).toBe("");
  });

  it("formats matched articles under the wiki header, scoped to the owner", async () => {
    search.mockResolvedValue([
      { title: "Niku Steakhouse", content: "Dinner reservation details." },
    ]);
    const out = await getRelevantArticles("local", "dinner");
    expect(search).toHaveBeenCalledWith("local", "dinner", 5);
    expect(out).toContain("## Personal Knowledge Wiki");
    expect(out).toContain("### Niku Steakhouse");
    expect(out).toContain("Dinner reservation details.");
  });

  it("respects the ~4000-char budget (truncates with an ellipsis)", async () => {
    search.mockResolvedValue([{ title: "Big", content: "y".repeat(5000) }]);
    const out = await getRelevantArticles("local", "big");
    expect(out.length).toBeLessThan(4300); // header + budget + ellipsis
    expect(out).toContain("...");
  });
});
