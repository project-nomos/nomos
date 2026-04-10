"use client";

import { useEffect, useState } from "react";
import { DollarSign, Clock, Cpu, TrendingUp } from "lucide-react";

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchRequests: number;
  costUsd: number;
  turnCount: number;
}

interface SessionCostData {
  sessionKey: string;
  model: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTurns: number;
  durationMs: number;
  modelUsage: Record<string, ModelUsage>;
  updatedAt: string;
}

interface CostSummary {
  sessions: SessionCostData[];
  totalCostUsd: number;
  totalSessions: number;
  totalTurns: number;
  modelsUsed: string[];
}

function formatCost(cost: number): string {
  if (cost >= 0.5) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function _formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

const MODEL_PRICING: Record<string, string> = {
  "claude-haiku-4-5": "$1/$5 per Mtok",
  "claude-3-5-haiku": "$0.80/$4 per Mtok",
  "claude-sonnet-4-6": "$3/$15 per Mtok",
  "claude-sonnet-4-5": "$3/$15 per Mtok",
  "claude-sonnet-4": "$3/$15 per Mtok",
  "claude-opus-4-6": "$5/$25 per Mtok",
  "claude-opus-4-5": "$5/$25 per Mtok",
  "claude-opus-4-1": "$15/$75 per Mtok",
  "claude-opus-4": "$15/$75 per Mtok",
};

export default function CostsPage() {
  const [data, setData] = useState<CostSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/admin/costs");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData(await res.json());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-mauve border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="text-center text-overlay0 py-16">{error || "Failed to load cost data."}</div>
    );
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-text mb-1">Cost Tracking</h1>
      <p className="text-sm text-overlay0 mb-8">Session usage and cost breakdown</p>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
        <div className="rounded-xl border border-surface0 bg-mantle p-5">
          <div className="flex items-center gap-2 mb-3">
            <DollarSign size={16} className="text-green" />
            <span className="text-xs font-semibold text-overlay0 uppercase tracking-wider">
              Total Cost
            </span>
          </div>
          <p className="text-lg font-bold text-text">{formatCost(data.totalCostUsd)}</p>
        </div>

        <div className="rounded-xl border border-surface0 bg-mantle p-5">
          <div className="flex items-center gap-2 mb-3">
            <Cpu size={16} className="text-blue" />
            <span className="text-xs font-semibold text-overlay0 uppercase tracking-wider">
              Sessions
            </span>
          </div>
          <p className="text-lg font-bold text-text">{data.totalSessions}</p>
        </div>

        <div className="rounded-xl border border-surface0 bg-mantle p-5">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={16} className="text-peach" />
            <span className="text-xs font-semibold text-overlay0 uppercase tracking-wider">
              Total Turns
            </span>
          </div>
          <p className="text-lg font-bold text-text">{data.totalTurns}</p>
        </div>

        <div className="rounded-xl border border-surface0 bg-mantle p-5">
          <div className="flex items-center gap-2 mb-3">
            <Clock size={16} className="text-mauve" />
            <span className="text-xs font-semibold text-overlay0 uppercase tracking-wider">
              Avg Cost / Session
            </span>
          </div>
          <p className="text-lg font-bold text-text">
            {data.totalSessions > 0 ? formatCost(data.totalCostUsd / data.totalSessions) : "$0"}
          </p>
        </div>
      </div>

      {/* Model Pricing — only configured/used models */}
      {data.modelsUsed.length > 0 && (
        <>
          <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
            Model Pricing
          </h2>
          <div className="rounded-xl border border-surface0 bg-mantle p-5 mb-10">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {data.modelsUsed.map((model) => {
                const canonical = model.replace(/-\d{8}$/, "").replace(/-latest$/, "");
                const pricing = MODEL_PRICING[canonical];
                if (!pricing) return null;
                return (
                  <div key={model} className="text-sm">
                    <span className="text-text font-medium">
                      {canonical.replace("claude-", "")}
                    </span>
                    <span className="text-overlay0 ml-2">{pricing}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Session History */}
      <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
        Recent Sessions
      </h2>
      {data.sessions.length === 0 ? (
        <div className="text-center text-overlay0 py-8 rounded-xl border border-surface0 bg-mantle">
          No session data yet. Start a conversation to begin tracking costs.
        </div>
      ) : (
        <div className="space-y-3">
          {data.sessions.map((session, i) => (
            <div
              key={`${session.sessionKey}-${i}`}
              className="rounded-xl border border-surface0 bg-mantle p-5"
            >
              <div className="flex items-center justify-between mb-3">
                <div>
                  <span className="text-sm font-medium text-text">{session.sessionKey}</span>
                  <span className="text-xs text-overlay0 ml-3">
                    {new Date(session.updatedAt).toLocaleDateString()}{" "}
                    {new Date(session.updatedAt).toLocaleTimeString()}
                  </span>
                </div>
                <span className="text-sm font-bold text-green">
                  {formatCost(session.totalCostUsd)}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs text-overlay0">
                <div>
                  <span className="block text-subtext0">Model</span>
                  <span className="text-text">{session.model?.replace("claude-", "") || "—"}</span>
                </div>
                <div>
                  <span className="block text-subtext0">Turns</span>
                  <span className="text-text">{session.totalTurns}</span>
                </div>
                <div>
                  <span className="block text-subtext0">Input</span>
                  <span className="text-text">{formatTokens(session.totalInputTokens)}</span>
                </div>
                <div>
                  <span className="block text-subtext0">Output</span>
                  <span className="text-text">{formatTokens(session.totalOutputTokens)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
