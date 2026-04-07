"use client";

import { useEffect, useState, useCallback } from "react";
import { Database, CheckCircle2, Loader2, AlertCircle, SkipForward } from "lucide-react";

interface IngestJob {
  platform: string;
  status: string;
  messages_processed: number;
  messages_skipped: number;
  error: string | null;
}

interface DataSyncStepProps {
  onComplete: () => void;
}

export function DataSyncStep({ onComplete }: DataSyncStepProps) {
  const [jobs, setJobs] = useState<IngestJob[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/ingestion");
      const data = await res.json();
      if (data.jobs) setJobs(data.jobs);
    } catch {
      // Ignore — no jobs yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 2000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  const hasRunningJobs = jobs.some((j) => j.status === "running");
  const allDone = jobs.length > 0 && jobs.every((j) => j.status !== "running");

  return (
    <div className="space-y-5">
      <div className="text-center">
        <Database className="w-10 h-10 text-mauve mx-auto mb-3" />
        <h2 className="text-lg font-semibold text-text">Data Sync</h2>
        <p className="text-sm text-overlay0 mt-1">
          Importing your message history to help Nomos learn your communication style.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-overlay0" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-6">
          <p className="text-sm text-overlay0">
            No channels configured yet. You can set up data ingestion later from Settings.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <div
              key={job.platform}
              className="flex items-center gap-3 p-3 rounded-lg border border-surface0"
            >
              <div className="flex-shrink-0">
                {job.status === "running" ? (
                  <Loader2 className="w-5 h-5 animate-spin text-blue-400" />
                ) : job.status === "completed" ? (
                  <CheckCircle2 className="w-5 h-5 text-green-400" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-red-400" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text">{job.platform}</div>
                <div className="text-xs text-overlay0">
                  {job.messages_processed.toLocaleString()} messages processed
                  {job.messages_skipped > 0 && `, ${job.messages_skipped} skipped`}
                </div>
                {job.error && <div className="text-xs text-red-400 mt-0.5">{job.error}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onComplete}
          className="flex-1 flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors bg-surface0 text-overlay0 hover:bg-surface1 hover:text-text"
        >
          <SkipForward className="w-4 h-4" />
          {jobs.length === 0 ? "Continue" : "Skip for now"}
        </button>
        {allDone && (
          <button
            type="button"
            onClick={onComplete}
            className="flex-1 rounded-lg px-4 py-2.5 text-sm font-medium bg-mauve text-crust hover:bg-mauve/90 transition-colors"
          >
            Continue
          </button>
        )}
      </div>

      {hasRunningJobs && (
        <p className="text-xs text-center text-overlay0">
          Syncing in progress... you can skip and it will continue in the background.
        </p>
      )}
    </div>
  );
}
