"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, Trash2, Zap, Plus } from "lucide-react";
import { TokenInput } from "@/components/token-input";
import { StatusBadge } from "@/components/status-badge";
import { ConfirmModal } from "@/components/confirm-modal";
import { DirtyIndicator } from "@/components/dirty-indicator";
import { useToast } from "@/contexts/toast-context";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import type { SlackWorkspace } from "@/lib/types";

export default function SlackSettingsPage() {
  const { addToast } = useToast();
  const [workspaces, setWorkspaces] = useState<SlackWorkspace[]>([]);
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [hasAppToken, setHasAppToken] = useState(false);
  const [hasBotToken, setHasBotToken] = useState(false);
  const [appTokenDirty, setAppTokenDirty] = useState(false);
  const [botTokenDirty, setBotTokenDirty] = useState(false);
  const [newToken, setNewToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});

  const isDirty = appTokenDirty || botTokenDirty;
  useUnsavedChanges(isDirty);

  const loadData = useCallback(async () => {
    try {
      const [wsRes, envRes] = await Promise.all([
        fetch("/api/slack/workspaces"),
        fetch("/api/env"),
      ]);
      const wsData = await wsRes.json();
      const envData = await envRes.json();

      setWorkspaces(wsData.workspaces ?? []);
      setHasAppToken(!!envData.SLACK_APP_TOKEN);
      setHasBotToken(!!envData.SLACK_BOT_TOKEN);
      setAppToken("");
      setBotToken("");
      setAppTokenDirty(false);
      setBotTokenDirty(false);
    } catch (err) {
      console.error("Failed to load Slack data:", err);
      addToast("Failed to load Slack data", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const saveTokens = async () => {
    if (!isDirty) return;
    setSaving(true);
    try {
      const updates: Record<string, string> = {};
      if (appTokenDirty) updates.SLACK_APP_TOKEN = appToken;
      if (botTokenDirty) updates.SLACK_BOT_TOKEN = botToken;

      const res = await fetch("/api/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      if (!res.ok) {
        const data = await res.json();
        addToast(data.error ?? "Failed to save tokens", "error");
        return;
      }

      addToast("Tokens saved successfully", "success");
      // Reload to get fresh has* flags
      await loadData();
    } catch (err) {
      console.error("Failed to save tokens:", err);
      addToast("Failed to save tokens", "error");
    } finally {
      setSaving(false);
    }
  };

  const connectWorkspace = async () => {
    if (!newToken.trim()) return;
    setConnecting(true);
    try {
      const res = await fetch("/api/slack/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: newToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        addToast(data.error ?? "Failed to connect workspace", "error");
        return;
      }
      addToast("Workspace connected successfully", "success");
      setNewToken("");
      await loadData();
    } catch (err) {
      console.error("Failed to connect workspace:", err);
      addToast("Failed to connect workspace", "error");
    } finally {
      setConnecting(false);
    }
  };

  const disconnectWorkspace = async (teamId: string) => {
    setDisconnecting(true);
    try {
      const res = await fetch(`/api/slack/workspaces?teamId=${teamId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json();
        addToast(data.error ?? "Failed to disconnect workspace", "error");
        return;
      }
      addToast("Workspace disconnected", "success");
      await loadData();
    } catch (err) {
      console.error("Failed to disconnect workspace:", err);
      addToast("Failed to disconnect workspace", "error");
    } finally {
      setDisconnecting(false);
      setDisconnectTarget(null);
    }
  };

  const testWorkspace = async (teamId: string) => {
    setTestResults((prev) => ({
      ...prev,
      [teamId]: { ok: false, message: "Testing..." },
    }));
    try {
      const res = await fetch("/api/slack/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      const data = await res.json();
      setTestResults((prev) => ({
        ...prev,
        [teamId]: { ok: data.ok, message: data.message ?? (data.ok ? "Connected" : "Failed") },
      }));
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [teamId]: { ok: false, message: "Test failed" },
      }));
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
        <h1 className="text-2xl font-bold text-text">Slack</h1>
        <DirtyIndicator isDirty={isDirty} />
      </div>
      <p className="text-sm text-overlay0 mb-8">
        Manage Slack workspace connections and tokens
      </p>

      {/* Connection Status */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Connection Status
        </h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-text">App Token (Socket Mode)</span>
            <StatusBadge
              status={hasAppToken ? "connected" : "not_configured"}
              label={hasAppToken ? "Configured" : "Missing"}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-text">Bot Token</span>
            <StatusBadge
              status={hasBotToken ? "connected" : "not_configured"}
              label={hasBotToken ? "Configured" : "Not set"}
            />
          </div>
        </div>
      </section>

      {/* Connected Workspaces */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Connected Workspaces
        </h2>
        {workspaces.length === 0 ? (
          <p className="text-sm text-overlay0">No workspaces connected.</p>
        ) : (
          <div className="space-y-3">
            {workspaces.map((ws) => (
              <div
                key={ws.team_id}
                className="flex items-center justify-between rounded-lg border border-surface0 bg-base p-3"
              >
                <div>
                  <p className="text-sm font-medium text-text">
                    {ws.team_name}
                  </p>
                  <p className="text-xs text-overlay0">
                    {ws.team_id} · User: {ws.user_id} · Connected:{" "}
                    {new Date(ws.created_at).toLocaleDateString()}
                  </p>
                  {testResults[ws.team_id] && (
                    <p
                      className={`text-xs mt-1 ${
                        testResults[ws.team_id].ok
                          ? "text-green"
                          : "text-red"
                      }`}
                    >
                      {testResults[ws.team_id].message}
                    </p>
                  )}
                </div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => testWorkspace(ws.team_id)}
                    className="p-1.5 rounded-md text-overlay0 hover:text-blue hover:bg-surface0 transition-colors"
                    title="Test connection"
                  >
                    <Zap size={14} />
                  </button>
                  <button
                    onClick={() => setDisconnectTarget(ws.team_id)}
                    className="p-1.5 rounded-md text-overlay0 hover:text-red hover:bg-surface0 transition-colors"
                    title="Disconnect"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Connect New Workspace */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Connect New Workspace
        </h2>
        <div className="space-y-3">
          <TokenInput
            label="User Token"
            value={newToken}
            onChange={setNewToken}
            placeholder="xoxp-..."
            helperText="Paste a Slack user token (xoxp-) to connect a workspace"
          />
          <button
            onClick={connectWorkspace}
            disabled={!newToken.trim() || connecting}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {connecting ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
            Connect
          </button>
        </div>
      </section>

      {/* App Token Configuration */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          App Token Configuration
        </h2>
        <div className="space-y-4">
          <TokenInput
            label="App Token"
            value={appToken}
            onChange={(v) => { setAppToken(v); setAppTokenDirty(true); }}
            placeholder={hasAppToken ? "Configured - enter new value to replace" : "xapp-..."}
            helperText="Required for Socket Mode. Generate at api.slack.com/apps → App-Level Tokens"
          />
          <TokenInput
            label="Bot Token"
            value={botToken}
            onChange={(v) => { setBotToken(v); setBotTokenDirty(true); }}
            placeholder={hasBotToken ? "Configured - enter new value to replace" : "xoxb-..."}
            helperText="Optional. Used for bot mode"
          />
          <button
            onClick={saveTokens}
            disabled={saving || !isDirty}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving && <RefreshCw size={14} className="animate-spin" />}
            Save to .env
          </button>
        </div>
      </section>

      {/* Confirm Modal for disconnect */}
      <ConfirmModal
        isOpen={!!disconnectTarget}
        title="Disconnect Workspace"
        message="Disconnect this workspace? The token will be revoked."
        confirmLabel={disconnecting ? "Disconnecting..." : "Disconnect"}
        variant="danger"
        onConfirm={() => disconnectTarget && disconnectWorkspace(disconnectTarget)}
        onCancel={() => setDisconnectTarget(null)}
      />
    </div>
  );
}
