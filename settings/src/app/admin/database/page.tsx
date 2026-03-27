"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, X, ChevronLeft, ChevronRight } from "lucide-react";
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

interface ColumnInfo {
  name: string;
  type: string;
}

interface TableData {
  table: string;
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  total: number;
  offset: number;
  limit: number;
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

/** Truncate long cell values for display. */
function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return json.length > 120 ? json.slice(0, 117) + "..." : json;
  }
  const str = String(value);
  return str.length > 120 ? str.slice(0, 117) + "..." : str;
}

const PAGE_SIZE = 50;

export default function DatabasePage() {
  const { addToast } = useToast();
  const [data, setData] = useState<DatabaseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Sheet state
  const [sheetTable, setSheetTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<TableData | null>(null);
  const [tableLoading, setTableLoading] = useState(false);
  const [tableOffset, setTableOffset] = useState(0);

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

  const loadTableData = useCallback(
    async (tableName: string, offset: number = 0) => {
      setTableLoading(true);
      try {
        const res = await fetch(
          `/api/admin/database/table?name=${encodeURIComponent(tableName)}&offset=${offset}&limit=${PAGE_SIZE}`,
        );
        const json = await res.json();
        if (json.error) {
          addToast(json.error, "error");
        } else {
          setTableData(json);
        }
      } catch (err) {
        addToast(err instanceof Error ? err.message : "Failed to load table", "error");
      } finally {
        setTableLoading(false);
      }
    },
    [addToast],
  );

  const openSheet = useCallback(
    (tableName: string) => {
      setSheetTable(tableName);
      setTableOffset(0);
      loadTableData(tableName, 0);
    },
    [loadTableData],
  );

  const closeSheet = useCallback(() => {
    setSheetTable(null);
    setTableData(null);
    setTableOffset(0);
  }, []);

  const goPage = useCallback(
    (newOffset: number) => {
      if (!sheetTable) return;
      setTableOffset(newOffset);
      loadTableData(sheetTable, newOffset);
    },
    [sheetTable, loadTableData],
  );

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Close sheet on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSheet();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [closeSheet]);

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
    <>
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
                    onClick={() => openSheet(t.name)}
                    className="border-b border-surface0/50 hover:bg-surface0/30 transition-colors cursor-pointer"
                  >
                    <td className="py-2 pr-4 font-mono text-mauve hover:text-lavender transition-colors">
                      {t.name}
                    </td>
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
                      <span className="text-subtext0">out:</span>{" "}
                      {formatTokens(s.tokenUsage?.output)}
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

      {/* Table Data Sheet (Slide-in from right) */}
      {sheetTable && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-crust/60 backdrop-blur-sm z-40 animate-fade-in"
            onClick={closeSheet}
          />

          {/* Sheet */}
          <div className="fixed inset-y-0 right-0 z-50 w-full max-w-3xl bg-base border-l border-surface0 shadow-2xl flex flex-col animate-in slide-in-from-right">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-surface0">
              <div>
                <h2 className="text-lg font-bold font-mono text-text">{sheetTable}</h2>
                {tableData && (
                  <p className="text-xs text-overlay0 mt-0.5">
                    {tableData.total} row{tableData.total !== 1 ? "s" : ""} &middot;{" "}
                    {tableData.columns.length} columns
                  </p>
                )}
              </div>
              <button
                onClick={closeSheet}
                className="p-1.5 rounded-lg hover:bg-surface0 text-overlay0 hover:text-text transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto">
              {tableLoading ? (
                <div className="flex items-center justify-center h-32">
                  <div className="w-5 h-5 border-2 border-mauve border-t-transparent rounded-full animate-spin" />
                </div>
              ) : tableData && tableData.rows.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-mantle z-10">
                      <tr className="border-b border-surface0">
                        {tableData.columns.map((col) => (
                          <th
                            key={col.name}
                            className="text-left py-2.5 px-3 text-xs font-semibold text-overlay0 whitespace-nowrap"
                            title={col.type}
                          >
                            {col.name}
                            <span className="ml-1 text-surface2 font-normal">{col.type}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableData.rows.map((row, i) => (
                        <tr
                          key={i}
                          className="border-b border-surface0/40 hover:bg-surface0/20 transition-colors"
                        >
                          {tableData.columns.map((col) => (
                            <td
                              key={col.name}
                              className="py-2 px-3 font-mono text-text whitespace-nowrap max-w-xs truncate"
                              title={
                                row[col.name] !== null && row[col.name] !== undefined
                                  ? typeof row[col.name] === "object"
                                    ? JSON.stringify(row[col.name])
                                    : String(row[col.name])
                                  : "NULL"
                              }
                            >
                              {row[col.name] === null || row[col.name] === undefined ? (
                                <span className="text-surface2 italic">NULL</span>
                              ) : (
                                formatCellValue(row[col.name])
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : tableData ? (
                <div className="flex items-center justify-center h-32 text-sm text-overlay0">
                  Table is empty
                </div>
              ) : null}
            </div>

            {/* Pagination Footer */}
            {tableData && tableData.total > PAGE_SIZE && (
              <div className="flex items-center justify-between px-6 py-3 border-t border-surface0 text-xs text-overlay0">
                <span>
                  Showing {tableOffset + 1}–{Math.min(tableOffset + PAGE_SIZE, tableData.total)} of{" "}
                  {tableData.total}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => goPage(Math.max(0, tableOffset - PAGE_SIZE))}
                    disabled={tableOffset === 0}
                    className="p-1 rounded hover:bg-surface0 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <button
                    onClick={() => goPage(tableOffset + PAGE_SIZE)}
                    disabled={tableOffset + PAGE_SIZE >= tableData.total}
                    className="p-1 rounded hover:bg-surface0 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
