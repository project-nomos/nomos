"use client";

import { useEffect, useState, useCallback } from "react";
import { Loader2, CheckCircle2, AlertCircle, Clock, Database } from "lucide-react";

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
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface SyncProgressProps {
  platform: string;
}

export function SyncProgress({ platform }: SyncProgressProps) {
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/ingestion");
      const data = await res.json();
      if (data.jobs) {
        setJobs(
          data.jobs.filter((j: IngestJob) =>
            j.platform.toLowerCase().startsWith(platform.toLowerCase()),
          ),
        );
      }
    } catch {
      // Silently fail — table may not exist yet
    } finally {
      setLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    fetchJobs();
    // Poll faster when a job is running
    const hasRunning = jobs.some((j) => j.status === "running");
    const interval = setInterval(fetchJobs, hasRunning ? 2000 : 10000);
    return () => clearInterval(interval);
  }, [fetchJobs, jobs.length > 0 && jobs.some((j) => j.status === "running")]);

  if (loading) return null;
  if (jobs.length === 0) return null;

  const running = jobs.find((j) => j.status === "running");
  const latest = jobs[0]; // Already sorted by started_at DESC from the API
  const totalProcessed = jobs.reduce((sum, j) => sum + j.messages_processed, 0);
  const totalSkipped = jobs.reduce((sum, j) => sum + j.messages_skipped, 0);

  return (
    <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
      <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
        Sync Progress
      </h2>

      {running && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-blue/20 bg-blue/5 px-4 py-3">
          <Loader2 size={16} className="animate-spin text-blue" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text">Syncing in progress...</p>
            <p className="text-xs text-overlay0 mt-0.5">
              {running.messages_processed.toLocaleString()} messages processed
              {running.messages_skipped > 0 && (
                <>, {running.messages_skipped.toLocaleString()} skipped</>
              )}
            </p>
          </div>
          <span className="text-xs text-overlay0 whitespace-nowrap">
            Started {formatRelativeTime(running.started_at)}
          </span>
        </div>
      )}

      {!running && latest && (
        <div
          className={`mb-4 flex items-center gap-3 rounded-lg border px-4 py-3 ${
            latest.status === "completed"
              ? "border-green/20 bg-green/5"
              : latest.status === "failed"
                ? "border-red/20 bg-red/5"
                : "border-surface1 bg-surface0/50"
          }`}
        >
          {latest.status === "completed" ? (
            <CheckCircle2 size={16} className="text-green" />
          ) : latest.status === "failed" ? (
            <AlertCircle size={16} className="text-red" />
          ) : (
            <Database size={16} className="text-overlay0" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text">
              {latest.status === "completed"
                ? "Last sync completed"
                : latest.status === "failed"
                  ? "Last sync failed"
                  : `Last sync: ${latest.status}`}
            </p>
            {latest.error && <p className="text-xs text-red mt-0.5">{latest.error}</p>}
          </div>
          <span className="text-xs text-overlay0 whitespace-nowrap flex items-center gap-1">
            <Clock size={12} />
            {formatRelativeTime(latest.finished_at ?? latest.started_at)}
          </span>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4 text-center">
        <div className="rounded-lg border border-surface1 bg-surface0/50 px-3 py-2.5">
          <div className="text-lg font-bold text-text">{totalProcessed.toLocaleString()}</div>
          <div className="text-xs text-overlay0">Messages synced</div>
        </div>
        <div className="rounded-lg border border-surface1 bg-surface0/50 px-3 py-2.5">
          <div className="text-lg font-bold text-text">{totalSkipped.toLocaleString()}</div>
          <div className="text-xs text-overlay0">Duplicates skipped</div>
        </div>
        <div className="rounded-lg border border-surface1 bg-surface0/50 px-3 py-2.5">
          <div className="text-lg font-bold text-text">{jobs.length}</div>
          <div className="text-xs text-overlay0">Sync runs</div>
        </div>
      </div>
    </section>
  );
}
