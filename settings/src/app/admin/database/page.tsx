"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { useToast } from "@/contexts/toast-context";

interface TableInfo {
  name: string;
  rowCount: number;
  size: string;
  sizeBytes: number;
}

interface SessionInfo {
  id: string;
  sessionKey: string;
  agentId: string | null;
  model: string | null;
  status: string | null;
  tokenUsage: { input?: number; output?: number } | null;
  createdAt: string;
  updatedAt: string;
}

interface DatabaseData {
  connection: {
    dbName: string;
    pgVersion: string;
    dbSize: string;
  };
  tables: TableInfo[];
  sessions: SessionInfo[];
  error?: string;
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

function formatTokens(n: number | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function DatabasePage() {
  const { addToast } = useToast();
  const [data, setData] = useState<DatabaseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/database");
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
      addToast("Failed to load database info", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
        <h1 className="text-2xl font-bold text-text mb-1">Database</h1>
        <p className="text-sm text-overlay0 mb-8">PostgreSQL overview and statistics</p>
        <section className="rounded-xl border border-surface0 bg-mantle p-5">
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider">
              Connection
            </h2>
            <StatusBadge status="error" />
          </div>
          <p className="text-sm text-red">{error}</p>
          <button
            onClick={() => {
              setLoading(true);
              loadData();
            }}
            className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-surface1 text-sm text-subtext0 hover:bg-surface0 transition-colors"
          >
            <RefreshCw size={14} />
            Retry
          </button>
        </section>
      </div>
    );
  }

  if (!data) return null;

  const totalRows = data.tables.reduce((sum, t) => sum + t.rowCount, 0);

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-text">Database</h1>
        <button
          onClick={() => {
            setLoading(true);
            loadData();
          }}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-surface1 text-sm text-subtext0 hover:bg-surface0 transition-colors"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      <p className="text-sm text-overlay0 mb-8">PostgreSQL overview and statistics</p>

      {/* Connection Info */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider">
            Connection
          </h2>
          <StatusBadge status="connected" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-overlay0 mb-1">Database</p>
            <p className="text-sm font-mono text-text">{data.connection.dbName}</p>
          </div>
          <div>
            <p className="text-xs text-overlay0 mb-1">Size</p>
            <p className="text-sm font-mono text-text">{data.connection.dbSize}</p>
          </div>
          <div>
            <p className="text-xs text-overlay0 mb-1">Version</p>
            <p className="text-sm font-mono text-text truncate" title={data.connection.pgVersion}>
              {data.connection.pgVersion.split(" ").slice(0, 2).join(" ")}
            </p>
          </div>
        </div>
      </section>

      {/* Table Stats */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider">Tables</h2>
          <span className="text-xs text-overlay0">
            {data.tables.length} tables &middot; {totalRows.toLocaleString()} rows
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface0">
                <th className="text-left py-2 pr-4 text-xs font-medium text-overlay0">Name</th>
                <th className="text-right py-2 px-4 text-xs font-medium text-overlay0">Rows</th>
                <th className="text-right py-2 pl-4 text-xs font-medium text-overlay0">Size</th>
              </tr>
            </thead>
            <tbody>
              {data.tables.map((t) => (
                <tr
                  key={t.name}
                  className="border-b border-surface0/50 hover:bg-surface0/30 transition-colors"
                >
                  <td className="py-2 pr-4 font-mono text-text">{t.name}</td>
                  <td className="py-2 px-4 text-right text-subtext0 tabular-nums">
                    {t.rowCount.toLocaleString()}
                  </td>
                  <td className="py-2 pl-4 text-right text-subtext0">{t.size}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent Sessions */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Recent Sessions
        </h2>
        {data.sessions.length === 0 ? (
          <p className="text-sm text-overlay0">No sessions found</p>
        ) : (
          <div className="space-y-2">
            {data.sessions.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-4 rounded-lg border border-surface0/50 bg-base px-4 py-2.5 text-sm"
              >
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-text truncate block">{s.sessionKey}</span>
                  {s.model && <span className="text-xs text-overlay0">{s.model}</span>}
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
                    s.status === "active"
                      ? "bg-green/15 text-green"
                      : "bg-surface1/50 text-overlay0"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      s.status === "active" ? "bg-green" : "bg-overlay0"
                    }`}
                  />
                  {s.status ?? "unknown"}
                </span>
                <div className="text-right text-xs text-overlay0 whitespace-nowrap w-28">
                  <div>
                    <span className="text-subtext0">in:</span> {formatTokens(s.tokenUsage?.input)}
                  </div>
                  <div>
                    <span className="text-subtext0">out:</span> {formatTokens(s.tokenUsage?.output)}
                  </div>
                </div>
                <span className="text-xs text-overlay0 whitespace-nowrap w-16 text-right">
                  {formatRelativeTime(s.updatedAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
