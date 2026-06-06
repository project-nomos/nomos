"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Network, RefreshCw, Search, X, ArrowLeft, Info } from "lucide-react";
import { GraphCanvas, colorForKind, type GNode, type GLink } from "@/components/graph-canvas";

interface KindFacet {
  kind: string;
  count: number;
}
interface RelFacet {
  relType: string;
  count: number;
}
interface GraphData {
  nodes: GNode[];
  links: GLink[];
  kinds: KindFacet[];
  relTypes: RelFacet[];
  stats: { totalNodes: number; totalEdges: number; shownNodes: number; shownEdges: number };
  error?: string;
}

const EMPTY: GraphData = {
  nodes: [],
  links: [],
  kinds: [],
  relTypes: [],
  stats: { totalNodes: 0, totalEdges: 0, shownNodes: 0, shownEdges: 0 },
};

export default function GraphPage() {
  const [data, setData] = useState<GraphData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [depth, setDepth] = useState(2);
  const [disabledKinds, setDisabledKinds] = useState<Set<string>>(new Set());
  const [showSemantic, setShowSemantic] = useState(true);
  const [showInvalid, setShowInvalid] = useState(false);
  const [hovered, setHovered] = useState<GNode | null>(null);
  const [selected, setSelected] = useState<GNode | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (focusId) {
        params.set("node", focusId);
        params.set("depth", String(depth));
      }
      if (showInvalid) params.set("includeInvalid", "true");
      const res = await fetch(`/api/admin/graph?${params.toString()}`);
      const json = (await res.json()) as GraphData;
      setData(json);
    } catch (e) {
      setData({ ...EMPTY, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [focusId, depth, showInvalid]);

  useEffect(() => {
    load();
  }, [load]);

  // Kind filtering (global mode only — local mode shows the ego-network as-is).
  const visibleNodes = useMemo(() => {
    if (focusId) return data.nodes;
    return data.nodes.filter((n) => !disabledKinds.has(n.kind));
  }, [data.nodes, disabledKinds, focusId]);

  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleLinks = useMemo(
    () => data.links.filter((l) => visibleIds.has(l.source) && visibleIds.has(l.target)),
    [data.links, visibleIds],
  );

  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return data.nodes
      .filter(
        (n) =>
          n.name.toLowerCase().includes(q) || n.aliases.some((a) => a.toLowerCase().includes(q)),
      )
      .slice(0, 8);
  }, [query, data.nodes]);

  const toggleKind = (kind: string) => {
    setDisabledKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const focusNode = (n: GNode) => {
    setSelected(n);
    setFocusId(n.id);
    setQuery("");
  };

  const detail = hovered ?? selected;

  return (
    // Full-bleed: cancel the app shell's p-8 and fill the viewport so the map is large.
    <div className="-m-8 flex h-screen flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-surface0 px-6 py-4">
        <div className="flex items-center gap-3">
          <Network className="text-mauve" size={20} />
          <div>
            <h1 className="text-lg font-semibold text-text">Knowledge Graph</h1>
            <p className="text-xs text-overlay0">
              {data.stats.totalNodes.toLocaleString()} entities ·{" "}
              {data.stats.totalEdges.toLocaleString()} relationships
              {data.stats.shownNodes < data.stats.totalNodes
                ? ` · showing ${data.stats.shownNodes.toLocaleString()}`
                : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {focusId && (
            <button
              onClick={() => {
                setFocusId(null);
                setSelected(null);
              }}
              className="flex items-center gap-1.5 rounded-lg border border-surface0 px-3 py-1.5 text-sm text-subtext0 hover:bg-surface0 hover:text-text"
            >
              <ArrowLeft size={14} /> Full graph
            </button>
          )}
          <button
            onClick={load}
            className="flex items-center gap-1.5 rounded-lg border border-surface0 px-3 py-1.5 text-sm text-subtext0 hover:bg-surface0 hover:text-text"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-surface0 px-6 py-3">
        {/* Search */}
        <div ref={searchRef} className="relative">
          <div className="flex items-center gap-2 rounded-lg border border-surface0 bg-base px-3 py-1.5">
            <Search size={14} className="text-overlay0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find an entity…"
              className="w-44 bg-transparent text-sm text-text outline-none placeholder:text-overlay0"
            />
            {query && (
              <button onClick={() => setQuery("")} className="text-overlay0 hover:text-text">
                <X size={14} />
              </button>
            )}
          </div>
          {searchMatches.length > 0 && (
            <div className="absolute z-10 mt-1 w-64 rounded-lg border border-surface0 bg-mantle py-1 shadow-lg">
              {searchMatches.map((n) => (
                <button
                  key={n.id}
                  onClick={() => focusNode(n)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-subtext0 hover:bg-surface0 hover:text-text"
                >
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: colorForKind(n.kind) }}
                  />
                  <span className="truncate">{n.name}</span>
                  <span className="ml-auto text-xs text-overlay0">{n.kind}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Kind filter chips (global mode) */}
        {!focusId && (
          <div className="flex flex-wrap items-center gap-1.5">
            {data.kinds.map((k) => {
              const on = !disabledKinds.has(k.kind);
              return (
                <button
                  key={k.kind}
                  onClick={() => toggleKind(k.kind)}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    on
                      ? "border-surface1 bg-surface0 text-text"
                      : "border-surface0 text-overlay0 hover:text-subtext0"
                  }`}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: on ? colorForKind(k.kind) : "#585b70" }}
                  />
                  {k.kind} <span className="text-overlay0">{k.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Depth slider (local mode) */}
        {focusId && (
          <label className="flex items-center gap-2 text-xs text-subtext0">
            Depth
            <input
              type="range"
              min={1}
              max={3}
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
              className="accent-mauve"
            />
            <span className="tabular-nums text-text">{depth}</span>
          </label>
        )}

        <div className="ml-auto flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5 text-subtext0">
            <input
              type="checkbox"
              checked={showSemantic}
              onChange={(e) => setShowSemantic(e.target.checked)}
              className="accent-teal"
            />
            Semantic edges
          </label>
          <label className="flex items-center gap-1.5 text-subtext0">
            <input
              type="checkbox"
              checked={showInvalid}
              onChange={(e) => setShowInvalid(e.target.checked)}
              className="accent-red"
            />
            Superseded
          </label>
        </div>
      </div>

      {/* Body — the canvas fills the whole area; the panel floats on top. */}
      <div className="relative min-h-0 flex-1 bg-base">
        {visibleNodes.length === 0 ? (
          <EmptyState error={data.error} loading={loading} />
        ) : (
          <div className="absolute inset-0">
            <GraphCanvas
              nodes={visibleNodes}
              links={visibleLinks}
              showSemantic={showSemantic}
              onNodeHover={setHovered}
              onNodeClick={focusNode}
            />
          </div>
        )}

        {/* Floating overlay: details + legend (does not steal map width). */}
        {visibleNodes.length > 0 && (
          <div className="pointer-events-auto absolute right-3 top-3 flex max-h-[calc(100%-1.5rem)] w-64 flex-col overflow-y-auto rounded-xl border border-surface0 bg-mantle/85 p-4 shadow-xl backdrop-blur">
            {detail ? (
              <NodeDetails
                node={detail}
                onFocus={() => focusNode(detail)}
                focused={focusId === detail.id}
              />
            ) : (
              <div className="flex items-start gap-2 rounded-lg border border-surface0 bg-base/60 p-3 text-xs text-overlay0">
                <Info size={14} className="mt-0.5 shrink-0" />
                <span>
                  Hover a node for details. Click to zoom into its local graph. Scroll to zoom, drag
                  to pan.
                </span>
              </div>
            )}

            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-overlay0">
                Legend
              </h3>
              <div className="flex flex-col gap-1.5">
                {data.kinds.map((k) => (
                  <div key={k.kind} className="flex items-center gap-2 text-xs text-subtext0">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: colorForKind(k.kind) }}
                    />
                    <span className="capitalize">{k.kind}</span>
                    <span className="ml-auto tabular-nums text-overlay0">{k.count}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-col gap-1 text-xs text-overlay0">
                <div className="flex items-center gap-2">
                  <span className="h-px w-6" style={{ background: "rgba(147,153,178,0.6)" }} />{" "}
                  explicit
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="h-px w-6 border-t border-dashed"
                    style={{ borderColor: "#94e2d5" }}
                  />{" "}
                  semantic
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="h-px w-6 border-t border-dashed"
                    style={{ borderColor: "#f38ba8" }}
                  />{" "}
                  superseded
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function NodeDetails({
  node,
  onFocus,
  focused,
}: {
  node: GNode;
  onFocus: () => void;
  focused: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-3 w-3 rounded-full"
          style={{ backgroundColor: colorForKind(node.kind) }}
        />
        <span className="text-xs uppercase tracking-wider text-overlay0">{node.kind}</span>
      </div>
      <h2 className="mt-1 break-words text-base font-semibold text-text">{node.name}</h2>
      {node.aliases.length > 0 && (
        <p className="mt-1 text-xs text-overlay0">aka {node.aliases.join(", ")}</p>
      )}
      {node.summary && <p className="mt-2 text-sm text-subtext0">{node.summary}</p>}
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md border border-surface0 bg-base p-2">
          <dt className="text-overlay0">Connections</dt>
          <dd className="text-text tabular-nums">{node.degree}</dd>
        </div>
        <div className="rounded-md border border-surface0 bg-base p-2">
          <dt className="text-overlay0">Confidence</dt>
          <dd className="text-text tabular-nums">{node.confidence.toFixed(2)}</dd>
        </div>
      </dl>
      {node.externalKind && (
        <p className="mt-2 text-xs text-overlay0">
          source: <span className="text-subtext0">{node.externalKind}</span>
          {node.externalRef ? ` · ${node.externalRef.slice(0, 28)}` : ""}
        </p>
      )}
      {!focused && (
        <button
          onClick={onFocus}
          className="mt-3 w-full rounded-lg bg-mauve/90 px-3 py-1.5 text-sm font-medium text-base hover:bg-mauve"
        >
          Explore local graph
        </button>
      )}
    </div>
  );
}

function EmptyState({ error, loading }: { error?: string; loading: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <Network size={40} className="text-surface1" />
      {loading ? (
        <p className="text-sm text-overlay0">Loading the graph…</p>
      ) : error ? (
        <>
          <p className="text-sm text-subtext0">The knowledge graph isn&apos;t available yet.</p>
          <p className="max-w-sm text-xs text-overlay0">
            Run <code className="rounded bg-surface0 px-1">nomos db migrate</code> then{" "}
            <code className="rounded bg-surface0 px-1">nomos brain backfill</code> to populate it
            from your contacts and wiki.
          </p>
          <p className="mt-1 max-w-sm truncate text-xs text-red/70">{error}</p>
        </>
      ) : (
        <>
          <p className="text-sm text-subtext0">No entities in the graph yet.</p>
          <p className="max-w-sm text-xs text-overlay0">
            The brain fills in as you chat. Or seed it now with{" "}
            <code className="rounded bg-surface0 px-1">nomos brain backfill</code>.
          </p>
        </>
      )}
    </div>
  );
}
