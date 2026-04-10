"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Bell,
  CheckCircle2,
  Clock,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { useToast } from "@/contexts/toast-context";

interface Commitment {
  id: string;
  description: string;
  deadline: string | null;
  status: string;
  reminded: boolean;
  created_at: string;
}

export default function ProactivePage() {
  const [enabled, setEnabled] = useState(false);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(true);
  const { addToast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      // Fetch proactive config
      const configRes = await fetch("/api/config");
      const configData = await configRes.json();
      if (configData.config) {
        const proactiveVal = configData.config.find(
          (c: { key: string }) => c.key === "app.proactiveEnabled",
        );
        setEnabled(proactiveVal?.value === "true");
      }

      // Fetch commitments from DB
      const dbRes = await fetch("/api/admin/database/table?table=commitments&limit=20");
      const dbData = await dbRes.json();
      if (dbData.rows) {
        setCommitments(dbData.rows);
      }
    } catch {
      // Table might not exist yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const toggleEnabled = async () => {
    try {
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "app.proactiveEnabled",
          value: enabled ? "false" : "true",
        }),
      });
      setEnabled(!enabled);
      addToast(`Proactive features ${enabled ? "disabled" : "enabled"}`, "success");
    } catch {
      addToast("Failed to toggle", "error");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  const pendingCommitments = commitments.filter((c) => c.status === "pending");
  const completedCommitments = commitments.filter((c) => c.status === "completed");

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Proactive Features</h1>
          <p className="text-sm text-gray-400 mt-1">
            Commitment tracking, meeting briefs, and priority triage
          </p>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={toggleEnabled}
            className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition"
          >
            {enabled ? (
              <ToggleRight className="w-6 h-6 text-green-400" />
            ) : (
              <ToggleLeft className="w-6 h-6" />
            )}
            {enabled ? "Enabled" : "Disabled"}
          </button>
          <button
            onClick={fetchData}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white text-sm transition"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      </div>

      {!enabled && (
        <div className="p-4 rounded-xl border border-yellow-500/20 bg-yellow-500/5">
          <p className="text-sm text-yellow-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            Proactive features are disabled. Enable them to start tracking commitments and
            generating triage summaries.
          </p>
        </div>
      )}

      {/* Feature cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <Bell className="w-5 h-5 text-blue-400 mb-2" />
          <h3 className="font-semibold text-white text-sm">Commitment Tracking</h3>
          <p className="text-xs text-gray-400 mt-1">
            Extracts promises and follow-ups from conversations. Reminds you before deadlines.
          </p>
          <div className="mt-3 text-lg font-bold text-white">{pendingCommitments.length}</div>
          <div className="text-xs text-gray-500">pending commitments</div>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <Clock className="w-5 h-5 text-purple-400 mb-2" />
          <h3 className="font-semibold text-white text-sm">Meeting Briefs</h3>
          <p className="text-xs text-gray-400 mt-1">
            Pre-meeting context with attendee history and suggested agenda items.
          </p>
          <div className="mt-3 text-xs text-gray-500">
            Triggered automatically before calendar events
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <CheckCircle2 className="w-5 h-5 text-green-400 mb-2" />
          <h3 className="font-semibold text-white text-sm">Priority Triage</h3>
          <p className="text-xs text-gray-400 mt-1">
            Daily summary of unread messages ranked by importance and urgency.
          </p>
          <div className="mt-3 text-xs text-gray-500">Delivered daily via configured channels</div>
        </div>
      </div>

      {/* Commitments list */}
      {pendingCommitments.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-white">Pending Commitments</h2>
          {pendingCommitments.map((c) => (
            <div key={c.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm text-white">{c.description}</p>
                  {c.deadline && (
                    <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Due: {new Date(c.deadline).toLocaleDateString()}
                    </p>
                  )}
                </div>
                {c.reminded && (
                  <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded-full">
                    Reminded
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {completedCommitments.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-white text-opacity-50">
            Completed ({completedCommitments.length})
          </h2>
          {completedCommitments.slice(0, 5).map((c) => (
            <div
              key={c.id}
              className="rounded-xl border border-white/5 bg-white/[0.02] p-3 opacity-60"
            >
              <p className="text-sm text-gray-400 line-through">{c.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
