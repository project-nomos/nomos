"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, Trash2, Loader2, AlertCircle, Bot, Package, User, Cog } from "lucide-react";
import { useToast } from "@/contexts/toast-context";

interface Loop {
  id: string;
  name: string;
  schedule: string;
  scheduleType: string;
  sessionTarget: string;
  deliveryMode: string;
  enabled: boolean;
  source: "bundled" | "user" | "agent" | string;
  errorCount: number;
  lastRun: string | null;
  lastError: string | null;
  createdAt: string | null;
  prompt: string;
}

const SOURCE_META: Record<string, { label: string; icon: typeof Bot; cls: string }> = {
  agent: { label: "Agent-created", icon: Bot, cls: "bg-indigo-500/15 text-indigo-300" },
  bundled: { label: "Bundled", icon: Package, cls: "bg-slate-500/15 text-slate-300" },
  user: { label: "You", icon: User, cls: "bg-emerald-500/15 text-emerald-300" },
  system: { label: "System", icon: Cog, cls: "bg-sky-500/15 text-sky-300" },
};

export default function LoopsAdminPage() {
  const { addToast } = useToast();
  const [loops, setLoops] = useState<Loop[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/loops");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to load");
      setLoops(data.loops ?? []);
    } catch (e) {
      addToast(e instanceof Error ? e.message : "Failed to load loops", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (id: string, action: string, extra?: Record<string, unknown>) => {
      setBusy(id);
      try {
        const res = await fetch("/api/admin/loops", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, action, ...extra }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "failed");
        await load();
      } catch (e) {
        addToast(e instanceof Error ? e.message : "Action failed", "error");
      } finally {
        setBusy(null);
      }
    },
    [addToast, load],
  );

  const editSchedule = useCallback(
    (loop: Loop) => {
      const next = window.prompt(`New schedule for "${loop.name}"`, loop.schedule);
      if (next && next.trim() && next.trim() !== loop.schedule) {
        void act(loop.id, "update", { schedule: next.trim() });
      }
    },
    [act],
  );

  const remove = useCallback(
    (loop: Loop) => {
      if (window.confirm(`Delete loop "${loop.name}"? This cannot be undone.`)) {
        void act(loop.id, "delete");
      }
    },
    [act],
  );

  const agentLoops = loops.filter((l) => l.source === "agent");
  const enabledCount = loops.filter((l) => l.enabled).length;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Autonomous Loops</h1>
          <p className="mt-1 text-sm text-overlay0">
            Recurring background jobs. The agent can create its own (marked{" "}
            <span className="text-indigo-300">Agent-created</span>); you can disable, reschedule, or
            delete any of them here. {loops.length} total, {enabledCount} enabled,{" "}
            {agentLoops.length} agent-created.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-2 rounded-lg border border-surface1 px-3 py-1.5 text-sm text-subtext1 hover:bg-surface0"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {loading && loops.length === 0 ? (
        <div className="flex items-center gap-2 text-overlay0">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading loops…
        </div>
      ) : loops.length === 0 ? (
        <p className="text-sm text-overlay0">No loops registered.</p>
      ) : (
        <div className="space-y-3">
          {loops.map((loop) => {
            const meta = SOURCE_META[loop.source] ?? SOURCE_META.bundled;
            const Icon = meta.icon;
            return (
              <div key={loop.id} className="rounded-xl border border-surface0 bg-mantle p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-text">{loop.name}</span>
                      <span
                        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${meta.cls}`}
                      >
                        <Icon className="h-3 w-3" />
                        {meta.label}
                      </span>
                      {loop.errorCount > 0 && (
                        <span className="inline-flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] text-red-300">
                          <AlertCircle className="h-3 w-3" />
                          {loop.errorCount} error{loop.errorCount > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-overlay0">
                      <code className="font-mono text-subtext0">
                        {loop.scheduleType}:{loop.schedule}
                      </code>
                      <span>{loop.deliveryMode}</span>
                      {loop.lastRun && (
                        <span>last run {loop.lastRun.slice(0, 16).replace("T", " ")}</span>
                      )}
                      <button
                        onClick={() => setExpanded(expanded === loop.id ? null : loop.id)}
                        className="text-mauve hover:underline"
                      >
                        {expanded === loop.id ? "hide prompt" : "view prompt"}
                      </button>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {loop.source === "system" ? (
                      <span className="text-xs text-overlay0" title="Managed by the daemon">
                        read-only
                      </span>
                    ) : (
                      <>
                        <button
                          onClick={() => editSchedule(loop)}
                          disabled={busy === loop.id}
                          className="rounded-md border border-surface1 px-2 py-1 text-xs text-subtext1 hover:bg-surface0 disabled:opacity-50"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => void act(loop.id, loop.enabled ? "disable" : "enable")}
                          disabled={busy === loop.id}
                          className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                            loop.enabled
                              ? "bg-green-500/15 text-green-300 hover:bg-green-500/25"
                              : "bg-surface1 text-subtext0 hover:bg-surface2"
                          }`}
                        >
                          {busy === loop.id ? "…" : loop.enabled ? "Enabled" : "Disabled"}
                        </button>
                        <button
                          onClick={() => remove(loop)}
                          disabled={busy === loop.id}
                          className="rounded-md p-1.5 text-overlay0 hover:bg-red-500/15 hover:text-red-300 disabled:opacity-50"
                          title="Delete loop"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {expanded === loop.id && (
                  <pre className="mt-3 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-crust p-3 text-xs text-subtext0">
                    {loop.prompt}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
