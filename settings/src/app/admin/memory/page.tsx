"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, Search, ChevronDown, ChevronRight } from "lucide-react";
import { useToast } from "@/contexts/toast-context";

interface MemoryStats {
  total: number;
  withEmbedding: number;
  withoutEmbedding: number;
  uniqueSources: number;
  totalTextSize: number;
}

interface SourceInfo {
  source: string;
  count: number;
}

interface ChunkInfo {
  id: string;
  source: string;
  path: string | null;
  textPreview: string;
  textLength: number;
  model: string | null;
  accessCount: number;
  createdAt: string;
  score?: number;
}

interface ChunkDetail extends Omit<ChunkInfo, "textPreview"> {
  text: string;
}

interface MemoryData {
  stats: MemoryStats;
  sources: SourceInfo[];
  recentChunks: ChunkInfo[];
  error?: string;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-surface0/50 bg-base p-4">
      <p className="text-xs text-overlay0 mb-1">{label}</p>
      <p className="text-xl font-semibold text-text tabular-nums">{typeof value === "number" ? value.toLocaleString() : value}</p>
    </div>
  );
}

function ChunkCard({
  chunk,
  expanded,
  onToggle,
  fullText,
  loadingDetail,
}: {
  chunk: ChunkInfo;
  expanded: boolean;
  onToggle: () => void;
  fullText: string | null;
  loadingDetail: boolean;
}) {
  return (
    <div className="rounded-lg border border-surface0/50 bg-base">
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-surface0/30 transition-colors"
      >
        <span className="mt-0.5 text-overlay0 shrink-0">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text line-clamp-2">{chunk.textPreview}</p>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-overlay0">
            <span className="font-mono">{chunk.source}</span>
            {chunk.path && <span className="truncate max-w-48">{chunk.path}</span>}
            {chunk.score != null && (
              <span className="text-mauve font-medium">score: {chunk.score.toFixed(3)}</span>
            )}
            <span className="ml-auto whitespace-nowrap">{formatRelativeTime(chunk.createdAt)}</span>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-surface0/50 px-4 py-3">
          {loadingDetail ? (
            <div className="flex items-center gap-2 text-sm text-overlay0">
              <div className="w-4 h-4 border-2 border-mauve border-t-transparent rounded-full animate-spin" />
              Loading full text...
            </div>
          ) : fullText ? (
            <div>
              <pre className="text-sm text-subtext0 whitespace-pre-wrap font-mono bg-surface0/30 rounded-lg p-3 max-h-80 overflow-y-auto">
                {fullText}
              </pre>
              <div className="flex items-center gap-4 mt-2 text-xs text-overlay0">
                <span>{chunk.textLength.toLocaleString()} chars</span>
                {chunk.model && <span>model: {chunk.model}</span>}
                <span>accessed: {chunk.accessCount}x</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-overlay0">Failed to load chunk detail</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function VectorMemoryPage() {
  const { addToast } = useToast();
  const [data, setData] = useState<MemoryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ChunkInfo[] | null>(null);
  const [searching, setSearching] = useState(false);

  const [expandedChunkId, setExpandedChunkId] = useState<string | null>(null);
  const [chunkDetails, setChunkDetails] = useState<Record<string, ChunkDetail>>({});
  const [loadingChunkId, setLoadingChunkId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/memory");
      const json = await res.json();
      if (json.error) {
        setError(json.error);
        setData(null);
      } else {
        setData(json);
        setError(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect";
      setError(message);
      setData(null);
      addToast("Failed to load memory data", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(`/api/admin/memory/search?q=${encodeURIComponent(q)}`);
      const json = await res.json();
      if (json.error) {
        addToast(json.error, "error");
        setSearchResults([]);
      } else {
        setSearchResults(json.results);
      }
    } catch {
      addToast("Search failed", "error");
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const toggleChunk = async (chunkId: string) => {
    if (expandedChunkId === chunkId) {
      setExpandedChunkId(null);
      return;
    }
    setExpandedChunkId(chunkId);
    if (chunkDetails[chunkId]) return;

    setLoadingChunkId(chunkId);
    try {
      const res = await fetch(`/api/admin/memory/${chunkId}`);
      const json = await res.json();
      if (json.error) {
        addToast("Failed to load chunk", "error");
      } else {
        setChunkDetails((prev) => ({ ...prev, [chunkId]: json }));
      }
    } catch {
      addToast("Failed to load chunk", "error");
    } finally {
      setLoadingChunkId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-mauve border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-2xl font-bold text-text mb-1">Vector Memory</h1>
        <p className="text-sm text-overlay0 mb-8">Explore indexed memory chunks and embeddings</p>
        <section className="rounded-xl border border-surface0 bg-mantle p-5">
          <p className="text-sm text-red mb-4">{error}</p>
          <button
            onClick={() => { setLoading(true); loadData(); }}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-surface1 text-sm text-subtext0 hover:bg-surface0 transition-colors"
          >
            <RefreshCw size={14} />
            Retry
          </button>
        </section>
      </div>
    );
  }

  if (!data) return null;

  const maxSourceCount = Math.max(...data.sources.map((s) => s.count), 1);
  const displayChunks = searchResults ?? data.recentChunks;

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-text">Vector Memory</h1>
        <button
          onClick={() => { setLoading(true); setSearchResults(null); setSearchQuery(""); loadData(); }}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-surface1 text-sm text-subtext0 hover:bg-surface0 transition-colors"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      <p className="text-sm text-overlay0 mb-8">Explore indexed memory chunks and embeddings</p>

      {/* Stats Cards */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">Overview</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total Chunks" value={data.stats.total} />
          <StatCard label="With Embeddings" value={data.stats.withEmbedding} />
          <StatCard label="Unique Sources" value={data.stats.uniqueSources} />
          <StatCard label="Total Text Size" value={formatBytes(data.stats.totalTextSize)} />
        </div>
      </section>

      {/* Source Breakdown */}
      {data.sources.length > 0 && (
        <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
          <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">Sources</h2>
          <div className="space-y-2">
            {data.sources.map((s) => (
              <div key={s.source} className="flex items-center gap-3">
                <span className="text-sm font-mono text-text w-36 truncate shrink-0" title={s.source}>
                  {s.source}
                </span>
                <div className="flex-1 h-5 bg-surface0/50 rounded overflow-hidden">
                  <div
                    className="h-full bg-mauve/40 rounded"
                    style={{ width: `${(s.count / maxSourceCount) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-overlay0 tabular-nums w-12 text-right">{s.count}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Search */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">Search</h2>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-overlay0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="Full-text search across memory chunks..."
              className="w-full rounded-lg border border-surface1 bg-surface0 pl-9 pr-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30"
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={searching}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-40"
          >
            {searching ? (
              <div className="w-4 h-4 border-2 border-crust border-t-transparent rounded-full animate-spin" />
            ) : (
              <Search size={14} />
            )}
            Search
          </button>
        </div>
        {searchResults !== null && (
          <p className="text-xs text-overlay0 mt-2">
            {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for &ldquo;{searchQuery}&rdquo;
          </p>
        )}
      </section>

      {/* Chunks */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          {searchResults ? "Search Results" : "Recent Chunks"}
        </h2>
        {displayChunks.length === 0 ? (
          <p className="text-sm text-overlay0">
            {searchResults ? "No matching chunks found" : "No memory chunks indexed yet"}
          </p>
        ) : (
          <div className="space-y-2">
            {displayChunks.map((chunk) => (
              <ChunkCard
                key={chunk.id}
                chunk={chunk}
                expanded={expandedChunkId === chunk.id}
                onToggle={() => toggleChunk(chunk.id)}
                fullText={chunkDetails[chunk.id]?.text ?? null}
                loadingDetail={loadingChunkId === chunk.id}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
