"use client";

import { useEffect, useState } from "react";
import { Activity, Layers, MessageSquare, Wrench, Brain, Sparkles } from "lucide-react";

interface ContextSection {
  label: string;
  tokens: number;
  color: string;
  percent: number;
}

interface ContextData {
  contextWindow: number;
  sections: ContextSection[];
  totalUsed: number;
  remaining: number;
  usagePercent: number;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

const SECTION_ICONS: Record<string, React.ComponentType<{ size: number; className?: string }>> = {
  "System Prompt": Layers,
  Conversation: MessageSquare,
  "Tool Schemas": Wrench,
  Memory: Brain,
  Skills: Sparkles,
};

export default function ContextPage() {
  const [data, setData] = useState<ContextData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/admin/context");
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
      <div className="text-center text-overlay0 py-16">
        {error || "Failed to load context data."}
      </div>
    );
  }

  const barWidth = 100; // percentage-based

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-text mb-1">Context Window</h1>
      <p className="text-sm text-overlay0 mb-8">Token budget breakdown for the current session</p>

      {/* Usage Summary */}
      <div className="rounded-xl border border-surface0 bg-mantle p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-mauve" />
            <span className="text-sm font-semibold text-text">
              {formatTokens(data.totalUsed)} / {formatTokens(data.contextWindow)} tokens
            </span>
          </div>
          <span
            className={`text-sm font-bold ${
              data.usagePercent > 90
                ? "text-red"
                : data.usagePercent > 75
                  ? "text-peach"
                  : "text-green"
            }`}
          >
            {data.usagePercent}% used
          </span>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-6 rounded-full bg-surface0 overflow-hidden flex">
          {data.sections.map((section) => (
            <div
              key={section.label}
              className="h-full transition-all duration-500"
              style={{
                width: `${(section.tokens / data.contextWindow) * barWidth}%`,
                backgroundColor: section.color,
                minWidth: section.tokens > 0 ? "2px" : "0",
              }}
              title={`${section.label}: ${formatTokens(section.tokens)} (${section.percent}%)`}
            />
          ))}
        </div>

        {/* Warning */}
        {data.usagePercent > 90 && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-red/10 border border-red/20">
            <p className="text-xs text-red font-medium">
              Context is {data.usagePercent}% full — compaction may trigger soon
            </p>
          </div>
        )}
        {data.usagePercent > 75 && data.usagePercent <= 90 && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-peach/10 border border-peach/20">
            <p className="text-xs text-peach font-medium">Context is {data.usagePercent}% full</p>
          </div>
        )}
      </div>

      {/* Section Breakdown */}
      <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
        Breakdown
      </h2>
      <div className="space-y-3">
        {data.sections.map((section) => {
          const Icon = SECTION_ICONS[section.label] || Layers;
          return (
            <div
              key={section.label}
              className="rounded-xl border border-surface0 bg-mantle p-4 flex items-center gap-4"
            >
              <div
                className="w-3 h-3 rounded-full shrink-0"
                style={{ backgroundColor: section.color }}
              />
              <Icon size={16} className="text-overlay0 shrink-0" />
              <span className="text-sm text-text flex-1">{section.label}</span>
              <span className="text-sm font-mono text-subtext0">
                {formatTokens(section.tokens)}
              </span>
              <span className="text-xs text-overlay0 w-12 text-right">{section.percent}%</span>
            </div>
          );
        })}

        {/* Available */}
        <div className="rounded-xl border border-surface0 bg-mantle p-4 flex items-center gap-4 opacity-60">
          <div className="w-3 h-3 rounded-full shrink-0 bg-surface1" />
          <Layers size={16} className="text-overlay0 shrink-0" />
          <span className="text-sm text-text flex-1">Available</span>
          <span className="text-sm font-mono text-subtext0">{formatTokens(data.remaining)}</span>
          <span className="text-xs text-overlay0 w-12 text-right">
            {Math.round((data.remaining / data.contextWindow) * 100)}%
          </span>
        </div>
      </div>

      {/* Model Context Limits */}
      <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mt-8 mb-4">
        Model Context Limits
      </h2>
      <div className="rounded-xl border border-surface0 bg-mantle p-5">
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-overlay0">Haiku 4.5</span>
            <span className="text-text font-medium ml-2">200K</span>
          </div>
          <div>
            <span className="text-overlay0">Sonnet 4.6</span>
            <span className="text-text font-medium ml-2">200K</span>
          </div>
          <div>
            <span className="text-overlay0">Opus 4.6</span>
            <span className="text-text font-medium ml-2">200K</span>
          </div>
        </div>
      </div>
    </div>
  );
}
