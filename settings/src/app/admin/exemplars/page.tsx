"use client";

import { useEffect, useState, useCallback } from "react";
import { Sparkles, Trash2, Clock, Filter } from "lucide-react";
import { useToast } from "@/contexts/toast-context";

interface ContextStat {
  context: string;
  count: number;
  avgScore: number;
}

interface Exemplar {
  id: string;
  textPreview: string;
  textLength: number;
  context: string;
  score: number;
  platform: string;
  reasoning: string;
  createdAt: string;
}

const CONTEXT_LABELS: Record<string, string> = {
  email_formal: "Email (Formal)",
  email_casual: "Email (Casual)",
  slack_casual: "Slack (Casual)",
  slack_work: "Slack (Work)",
  code_review: "Code Review",
  technical_discussion: "Technical",
  personal: "Personal",
  conflict_resolution: "Conflict Resolution",
  planning: "Planning",
  general: "General",
};

function formatRelativeTime(dateStr: string): string {
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

function scoreColor(score: number): string {
  if (score >= 0.85) return "text-green";
  if (score >= 0.7) return "text-yellow";
  return "text-peach";
}

function scoreBg(score: number): string {
  if (score >= 0.85) return "bg-green/10 border-green/20";
  if (score >= 0.7) return "bg-yellow/10 border-yellow/20";
  return "bg-peach/10 border-peach/20";
}

export default function ExemplarsPage() {
  const [total, setTotal] = useState(0);
  const [contexts, setContexts] = useState<ContextStat[]>([]);
  const [exemplars, setExemplars] = useState<Exemplar[]>([]);
  const [selectedExemplar, setSelectedExemplar] = useState<Exemplar | null>(null);
  const [contextFilter, setContextFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { addToast } = useToast();

  const fetchExemplars = useCallback(async () => {
    try {
      const url = contextFilter
        ? `/api/admin/exemplars?context=${encodeURIComponent(contextFilter)}`
        : "/api/admin/exemplars";
      const res = await fetch(url);
      const data = await res.json();
      setTotal(data.total ?? 0);
      setContexts(data.contexts ?? []);
      setExemplars(data.exemplars ?? []);
    } catch {
      // API not available
    } finally {
      setLoading(false);
    }
  }, [contextFilter]);

  useEffect(() => {
    fetchExemplars();
  }, [fetchExemplars]);

  const deleteExemplar = async (id: string) => {
    try {
      const res = await fetch("/api/admin/exemplars", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (data.ok) {
        addToast("Exemplar removed", "success");
        setExemplars((prev) => prev.filter((e) => e.id !== id));
        if (selectedExemplar?.id === id) setSelectedExemplar(null);
        setTotal((prev) => prev - 1);
      } else {
        addToast(data.error ?? "Failed to delete", "error");
      }
    } catch {
      addToast("Failed to delete exemplar", "error");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-mauve border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-text">Exemplar Library</h1>
        <span className="text-sm text-overlay0">{total} exemplars</span>
      </div>
      <p className="text-sm text-overlay0 mb-6">
        Real messages scored for representativeness. Used as few-shot examples when the agent
        responds on your behalf. Higher scores = more distinctive voice.
      </p>

      {/* Context stats */}
      {contexts.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          <button
            onClick={() => setContextFilter(null)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              contextFilter === null
                ? "border-mauve bg-mauve/10 text-mauve"
                : "border-surface1 bg-surface0 text-subtext0 hover:border-surface1"
            }`}
          >
            <Filter size={10} />
            All ({total})
          </button>
          {contexts.map((ctx) => (
            <button
              key={ctx.context}
              onClick={() => setContextFilter(ctx.context === contextFilter ? null : ctx.context)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                contextFilter === ctx.context
                  ? "border-mauve bg-mauve/10 text-mauve"
                  : "border-surface1 bg-surface0 text-subtext0 hover:border-surface1"
              }`}
            >
              {CONTEXT_LABELS[ctx.context] ?? ctx.context} ({ctx.count})
              <span className="text-overlay0">avg {ctx.avgScore}</span>
            </button>
          ))}
        </div>
      )}

      {exemplars.length === 0 ? (
        <div className="text-center py-16 text-overlay0">
          <Sparkles size={32} className="mx-auto mb-3 opacity-50" />
          <p>No exemplars yet.</p>
          <p className="text-xs mt-1">
            Exemplars are automatically scored from your incoming messages across all channels.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {/* Exemplar list */}
          <div className="md:col-span-2 space-y-2 max-h-[70vh] overflow-y-auto">
            {exemplars.map((exemplar) => (
              <button
                key={exemplar.id}
                onClick={() => setSelectedExemplar(exemplar)}
                className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                  selectedExemplar?.id === exemplar.id
                    ? "border-mauve bg-mauve/10"
                    : "border-surface0 bg-mantle hover:border-surface1"
                }`}
              >
                <div className="text-sm text-text line-clamp-2 leading-snug">
                  {exemplar.textPreview}
                </div>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className={`text-xs font-mono font-bold ${scoreColor(exemplar.score)}`}>
                    {exemplar.score.toFixed(2)}
                  </span>
                  <span className="text-xs text-overlay0">
                    {CONTEXT_LABELS[exemplar.context] ?? exemplar.context}
                  </span>
                  <span className="text-xs text-overlay0">{exemplar.platform}</span>
                  <span className="text-xs text-overlay0 flex items-center gap-0.5 ml-auto">
                    <Clock size={9} />
                    {formatRelativeTime(exemplar.createdAt)}
                  </span>
                </div>
              </button>
            ))}
          </div>

          {/* Detail pane */}
          <div className="md:col-span-3">
            {selectedExemplar ? (
              <div className="rounded-xl border border-surface0 bg-mantle p-5 sticky top-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold border ${scoreBg(selectedExemplar.score)} ${scoreColor(selectedExemplar.score)}`}
                    >
                      Score: {selectedExemplar.score.toFixed(2)}
                    </span>
                    <span className="text-xs text-overlay0">
                      {CONTEXT_LABELS[selectedExemplar.context] ?? selectedExemplar.context}
                    </span>
                    <span className="text-xs text-overlay0">via {selectedExemplar.platform}</span>
                  </div>
                  <button
                    onClick={() => deleteExemplar(selectedExemplar.id)}
                    className="p-1.5 rounded-lg text-red/60 hover:text-red hover:bg-red/10 transition-colors"
                    title="Remove exemplar"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* Message text */}
                <div className="rounded-lg border border-surface1 bg-base p-4 mb-4">
                  <p className="text-sm text-text whitespace-pre-wrap leading-relaxed">
                    {selectedExemplar.textPreview}
                    {selectedExemplar.textLength > 500 && (
                      <span className="text-overlay0">
                        {" "}
                        ...({selectedExemplar.textLength} chars)
                      </span>
                    )}
                  </p>
                </div>

                {/* Reasoning */}
                {selectedExemplar.reasoning && (
                  <div>
                    <h3 className="text-xs font-semibold text-subtext1 uppercase tracking-wider mb-1.5">
                      Why this is representative
                    </h3>
                    <p className="text-sm text-subtext0 leading-relaxed">
                      {selectedExemplar.reasoning}
                    </p>
                  </div>
                )}

                <div className="mt-3 pt-3 border-t border-surface0 text-xs text-overlay0 flex items-center gap-1">
                  <Clock size={10} />
                  Scored {formatRelativeTime(selectedExemplar.createdAt)}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-surface0 bg-mantle p-5 text-center text-overlay0 py-16">
                Select an exemplar to view details
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
