"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, ExternalLink } from "lucide-react";
import { TokenInput } from "@/components/token-input";
import { StatusBadge } from "@/components/status-badge";
import { SyncProgress } from "@/components/sync-progress";
import { DirtyIndicator } from "@/components/dirty-indicator";
import { useToast } from "@/contexts/toast-context";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";

export default function DiscordSettingsPage() {
  const { addToast } = useToast();
  const [botToken, setBotToken] = useState("");
  const [hasBotToken, setHasBotToken] = useState(false);
  const [botTokenDirty, setBotTokenDirty] = useState(false);
  const [allowedChannels, setAllowedChannels] = useState("");
  const [initialAllowedChannels, setInitialAllowedChannels] = useState("");
  const [allowedGuilds, setAllowedGuilds] = useState("");
  const [initialAllowedGuilds, setInitialAllowedGuilds] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const isDirty =
    botTokenDirty ||
    allowedChannels !== initialAllowedChannels ||
    allowedGuilds !== initialAllowedGuilds;
  useUnsavedChanges(isDirty);

  const loadData = useCallback(async () => {
    try {
      const [statusRes, envRes] = await Promise.all([fetch("/api/status"), fetch("/api/env")]);
      const statusData = await statusRes.json();
      const envData = await envRes.json();

      setHasBotToken(statusData.discord?.botToken ?? false);
      setBotToken("");
      setBotTokenDirty(false);

      const channels = envData.DISCORD_ALLOWED_CHANNELS ?? "";
      const guilds = envData.DISCORD_ALLOWED_GUILDS ?? "";
      setAllowedChannels(channels);
      setInitialAllowedChannels(channels);
      setAllowedGuilds(guilds);
      setInitialAllowedGuilds(guilds);
    } catch (err) {
      console.error("Failed to load Discord data:", err);
      addToast("Failed to load Discord data", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const save = async () => {
    if (!isDirty) return;
    setSaving(true);
    try {
      const updates: Record<string, string> = {};
      if (botTokenDirty) updates.DISCORD_BOT_TOKEN = botToken;
      if (allowedChannels !== initialAllowedChannels) {
        updates.DISCORD_ALLOWED_CHANNELS = allowedChannels;
      }
      if (allowedGuilds !== initialAllowedGuilds) {
        updates.DISCORD_ALLOWED_GUILDS = allowedGuilds;
      }

      const res = await fetch("/api/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      if (!res.ok) {
        const data = await res.json();
        addToast(data.error ?? "Failed to save", "error");
        return;
      }

      addToast("Discord settings saved", "success");
      await loadData();
      // Auto-trigger ingestion for Discord
      fetch("/api/ingestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "discord", action: "trigger-ingest" }),
      }).catch(() => {});
    } catch (err) {
      console.error("Failed to save Discord settings:", err);
      addToast("Failed to save settings", "error");
    } finally {
      setSaving(false);
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
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-1">
        <h1 className="text-2xl font-bold text-text">Discord</h1>
        <DirtyIndicator isDirty={isDirty} />
      </div>
      <div className="flex items-center gap-3 mb-8">
        <p className="text-sm text-overlay0">Configure Discord bot integration</p>
        <div className="flex items-center gap-2">
          <a
            href="https://discord.com/developers/applications"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue hover:text-blue/80"
          >
            Developer Portal <ExternalLink size={10} />
          </a>
          <span className="text-overlay0">·</span>
          <a
            href="https://discordjs.guide/preparations/setting-up-a-bot-application.html"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue hover:text-blue/80"
          >
            Setup Guide <ExternalLink size={10} />
          </a>
        </div>
      </div>

      {/* Connection Status */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Connection Status
        </h2>
        <div className="flex items-center justify-between">
          <span className="text-sm text-text">Bot Token</span>
          <StatusBadge
            status={hasBotToken ? "connected" : "not_configured"}
            label={hasBotToken ? "Configured" : "Not set"}
          />
        </div>
      </section>

      {/* Bot Token */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Bot Token
        </h2>
        <TokenInput
          label="Discord Bot Token"
          value={botToken}
          onChange={(v) => {
            setBotToken(v);
            setBotTokenDirty(true);
          }}
          placeholder={
            hasBotToken
              ? "Configured - enter new value to replace"
              : "Bot token from Discord Developer Portal"
          }
          helperText="Create a bot at discord.com/developers/applications"
        />
      </section>

      {/* Access Control */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Access Control
        </h2>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-subtext1">Allowed Channels</label>
            <input
              type="text"
              value={allowedChannels}
              onChange={(e) => setAllowedChannels(e.target.value)}
              placeholder="channel-id-1, channel-id-2"
              className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
            />
            <p className="text-xs text-overlay0">
              Comma-separated channel IDs. Leave empty to allow all.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-subtext1">
              Allowed Guilds (Servers)
            </label>
            <input
              type="text"
              value={allowedGuilds}
              onChange={(e) => setAllowedGuilds(e.target.value)}
              placeholder="guild-id-1, guild-id-2"
              className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
            />
            <p className="text-xs text-overlay0">
              Comma-separated guild IDs. Leave empty to allow all.
            </p>
          </div>
        </div>
      </section>

      {/* Sync Progress */}
      {hasBotToken && <SyncProgress platform="discord" />}

      {/* Save */}
      <button
        onClick={save}
        disabled={saving || !isDirty}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {saving && <RefreshCw size={14} className="animate-spin" />}
        Save
      </button>
    </div>
  );
}
