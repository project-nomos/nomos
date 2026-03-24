"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Radio, User, Brain, ArrowRight } from "lucide-react";
import type { IntegrationStatus } from "@/lib/types";

interface DashboardData {
  identity: { name: string; emoji: string };
  model: string;
  activeChannels: number;
  memoryChunks: number;
}

function countActiveChannels(status: IntegrationStatus): number {
  let count = 0;
  if (status.slack?.configured) count++;
  if (status.discord?.configured) count++;
  if (status.telegram?.configured) count++;
  if (status.google?.configured) count++;
  if (status.whatsapp?.configured) count++;
  return count;
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [statusRes, envRes, configRes] = await Promise.all([
          fetch("/api/status"),
          fetch("/api/env"),
          fetch("/api/config"),
        ]);

        const status: IntegrationStatus = await statusRes.json();
        const env = await envRes.json();
        const config = await configRes.json();

        // Count memory chunks
        let memoryChunks = 0;
        try {
          const memRes = await fetch("/api/admin/memory?count=true");
          if (memRes.ok) {
            const memData = await memRes.json();
            memoryChunks = memData.count ?? 0;
          }
        } catch {
          // Memory endpoint may not exist yet
        }

        setData({
          identity: {
            name: (config["agent.name"] as string) || "Nomos",
            emoji: (config["agent.emoji"] as string) || "",
          },
          model: env.NOMOS_MODEL || "claude-sonnet-4-6",
          activeChannels: countActiveChannels(status),
          memoryChunks,
        });
      } catch (err) {
        console.error("Failed to load dashboard data:", err);
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

  if (!data) {
    return <div className="text-center text-overlay0 py-16">Failed to load dashboard data.</div>;
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-text mb-1">Dashboard</h1>
      <p className="text-sm text-overlay0 mb-8">Overview of your assistant</p>

      {/* Status Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
        <div className="rounded-xl border border-surface0 bg-mantle p-5">
          <div className="flex items-center gap-2 mb-3">
            <User size={16} className="text-mauve" />
            <span className="text-xs font-semibold text-overlay0 uppercase tracking-wider">
              Assistant
            </span>
          </div>
          <p className="text-lg font-bold text-text truncate">
            {data.identity.emoji ? `${data.identity.emoji} ` : ""}
            {data.identity.name}
          </p>
        </div>

        <div className="rounded-xl border border-surface0 bg-mantle p-5">
          <div className="flex items-center gap-2 mb-3">
            <Brain size={16} className="text-mauve" />
            <span className="text-xs font-semibold text-overlay0 uppercase tracking-wider">
              Model
            </span>
          </div>
          <p className="text-lg font-bold text-text truncate">{data.model}</p>
        </div>

        <div className="rounded-xl border border-surface0 bg-mantle p-5">
          <div className="flex items-center gap-2 mb-3">
            <Radio size={16} className="text-mauve" />
            <span className="text-xs font-semibold text-overlay0 uppercase tracking-wider">
              Channels
            </span>
          </div>
          <p className="text-lg font-bold text-text">{data.activeChannels} active</p>
        </div>

        <div className="rounded-xl border border-surface0 bg-mantle p-5">
          <div className="flex items-center gap-2 mb-3">
            <Brain size={16} className="text-mauve" />
            <span className="text-xs font-semibold text-overlay0 uppercase tracking-wider">
              Memory
            </span>
          </div>
          <p className="text-lg font-bold text-text">{data.memoryChunks.toLocaleString()} chunks</p>
        </div>
      </div>

      {/* Quick Actions */}
      <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
        Quick Actions
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Link
          href="/integrations"
          className="group rounded-xl border border-surface0 bg-mantle p-5 hover:border-mauve/50 transition-colors"
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-text mb-1">Connect a Channel</h3>
              <p className="text-xs text-overlay0">Add Slack, Discord, Telegram, or more</p>
            </div>
            <ArrowRight
              size={16}
              className="text-overlay0 group-hover:text-mauve transition-colors"
            />
          </div>
        </Link>

        <Link
          href="/settings"
          className="group rounded-xl border border-surface0 bg-mantle p-5 hover:border-mauve/50 transition-colors"
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-text mb-1">Customize Personality</h3>
              <p className="text-xs text-overlay0">Set name, emoji, and purpose</p>
            </div>
            <ArrowRight
              size={16}
              className="text-overlay0 group-hover:text-mauve transition-colors"
            />
          </div>
        </Link>

        <Link
          href="/admin/memory"
          className="group rounded-xl border border-surface0 bg-mantle p-5 hover:border-mauve/50 transition-colors"
        >
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-text mb-1">View Memory</h3>
              <p className="text-xs text-overlay0">Browse stored knowledge and context</p>
            </div>
            <ArrowRight
              size={16}
              className="text-overlay0 group-hover:text-mauve transition-colors"
            />
          </div>
        </Link>
      </div>
    </div>
  );
}
