"use client";

import { useEffect, useState, useCallback } from "react";
import {
  RefreshCw,
  Database,
  Clock,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { useToast } from "@/contexts/toast-context";

interface IngestJob {
  id: string;
  platform: string;
  source_type: string;
  status: "running" | "completed" | "failed" | "cancelled";
  contact: string | null;
  messages_processed: number;
  messages_skipped: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  last_successful_at: string | null;
  delta_schedule: string;
  delta_enabled: boolean;
}

interface IngestStats {
  total_jobs: number;
  completed: number;
  running: number;
  failed: number;
  total_messages: number;
  total_skipped: number;
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: "bg-green-500/20 text-green-400",
    running: "bg-blue-500/20 text-blue-400",
    failed: "bg-red-500/20 text-red-400",
    cancelled: "bg-gray-500/20 text-gray-400",
  };
  const icons: Record<string, React.ReactNode> = {
    completed: <CheckCircle2 className="w-3 h-3" />,
    running: <Loader2 className="w-3 h-3 animate-spin" />,
    failed: <AlertCircle className="w-3 h-3" />,
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] ?? styles.cancelled}`}
    >
      {icons[status]} {status}
    </span>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className="text-2xl font-bold text-white">
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

export default function IngestionPage() {
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [stats, setStats] = useState<IngestStats | null>(null);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/ingestion");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setJobs(data.jobs);
      setStats(data.stats);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load ingestion data", "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const toggleDelta = async (platform: string) => {
    try {
      await fetch("/api/ingestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, action: "toggle-delta" }),
      });
      await fetchData();
      showToast("Delta sync toggled", "success");
    } catch {
      showToast("Failed to toggle delta sync", "error");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Data Ingestion</h1>
          <p className="text-sm text-gray-400 mt-1">
            Historical message ingestion and delta sync status
          </p>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white text-sm transition"
        >
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Total Messages" value={stats.total_messages} />
          <StatCard label="Skipped (Dupes)" value={stats.total_skipped} />
          <StatCard label="Completed Jobs" value={stats.completed} />
          <StatCard label="Failed Jobs" value={stats.failed} />
        </div>
      )}

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Database className="w-5 h-5" /> Ingestion Jobs
        </h2>

        {jobs.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <Database className="w-8 h-8 mx-auto mb-3 opacity-50" />
            <p>No ingestion jobs yet.</p>
            <p className="text-sm mt-1">
              Run <code className="text-blue-400">nomos ingest &lt;platform&gt;</code> to start
              ingesting data.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-semibold text-white">{job.platform}</span>
                    <span className="text-xs text-gray-500">({job.source_type})</span>
                    <StatusBadge status={job.status} />
                  </div>
                  <button
                    onClick={() => toggleDelta(job.platform)}
                    className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition"
                    title={job.delta_enabled ? "Disable delta sync" : "Enable delta sync"}
                  >
                    {job.delta_enabled ? (
                      <ToggleRight className="w-5 h-5 text-green-400" />
                    ) : (
                      <ToggleLeft className="w-5 h-5" />
                    )}
                    Delta: {job.delta_schedule}
                  </button>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div>
                    <span className="text-gray-500">Processed:</span>{" "}
                    <span className="text-white">{job.messages_processed.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Skipped:</span>{" "}
                    <span className="text-white">{job.messages_skipped.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Clock className="w-3 h-3 text-gray-500" />
                    <span className="text-gray-500">Started:</span>{" "}
                    <span className="text-white">{formatRelativeTime(job.started_at)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Clock className="w-3 h-3 text-gray-500" />
                    <span className="text-gray-500">Last sync:</span>{" "}
                    <span className="text-white">{formatRelativeTime(job.last_successful_at)}</span>
                  </div>
                </div>

                {job.error && (
                  <div className="mt-3 p-2 rounded-lg bg-red-500/10 border border-red-500/20">
                    <p className="text-xs text-red-400 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> {job.error}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
