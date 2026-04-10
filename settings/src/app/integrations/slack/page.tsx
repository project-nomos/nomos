"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, Trash2, Zap, Plus, ExternalLink, KeyRound, Globe, Bell } from "lucide-react";
import { TokenInput } from "@/components/token-input";
import { StatusBadge } from "@/components/status-badge";
import { SyncProgress } from "@/components/sync-progress";
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
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [hasAppToken, setHasAppToken] = useState(false);
  const [hasBotToken, setHasBotToken] = useState(false);
  const [hasClientId, setHasClientId] = useState(false);
  const [hasClientSecret, setHasClientSecret] = useState(false);
  const [appTokenDirty, setAppTokenDirty] = useState(false);
  const [botTokenDirty, setBotTokenDirty] = useState(false);
  const [clientIdDirty, setClientIdDirty] = useState(false);
  const [clientSecretDirty, setClientSecretDirty] = useState(false);
  const [newToken, setNewToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [browserAuth, setBrowserAuth] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>(
    {},
  );

  const isDirty = appTokenDirty || botTokenDirty || clientIdDirty || clientSecretDirty;
  useUnsavedChanges(isDirty);

  const hasOAuthCreds = hasClientId && hasClientSecret;
  const [browserAuthEnabled, setBrowserAuthEnabled] = useState(false);
  const [notifDefault, setNotifDefault] = useState<{
    platform: string;
    channelId: string;
    label?: string;
  } | null>(null);
  const [savingNotif, setSavingNotif] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [wsRes, envRes, notifRes] = await Promise.all([
        fetch("/api/slack/workspaces"),
        fetch("/api/env"),
        fetch("/api/notifications"),
      ]);
      const wsData = await wsRes.json();
      const notifData = await notifRes.json();
      setNotifDefault(notifData);
      const envData = await envRes.json();

      setWorkspaces(wsData.workspaces ?? []);
      setHasAppToken(!!envData.SLACK_APP_TOKEN);
      setHasBotToken(!!envData.SLACK_BOT_TOKEN);
      setHasClientId(!!envData.SLACK_CLIENT_ID);
      setHasClientSecret(!!envData.SLACK_CLIENT_SECRET);
      setBrowserAuthEnabled(!!envData.NOMOS_BROWSER_AUTH);
      setAppToken("");
      setBotToken("");
      setClientId("");
      setClientSecret("");
      setAppTokenDirty(false);
      setBotTokenDirty(false);
      setClientIdDirty(false);
      setClientSecretDirty(false);
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
      if (clientIdDirty) updates.SLACK_CLIENT_ID = clientId;
      if (clientSecretDirty) updates.SLACK_CLIENT_SECRET = clientSecret;

      const res = await fetch("/api/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      if (!res.ok) {
        const data = await res.json();
        addToast(data.error ?? "Failed to save settings", "error");
        return;
      }

      addToast("Settings saved successfully", "success");
      await loadData();
    } catch (err) {
      console.error("Failed to save settings:", err);
      addToast("Failed to save settings", "error");
    } finally {
      setSaving(false);
    }
  };

  const startOAuth = async () => {
    setAuthorizing(true);
    try {
      const res = await fetch("/api/slack/oauth/start", { method: "POST" });
      const data = await res.json();
      if (data.error) {
        addToast(data.error, "error");
        return;
      }
      if (data.url) {
        window.open(data.url, "_blank");
        addToast("Slack authorization opened — complete sign-in in the new tab", "success");
      }
      // Poll for new workspace
      const prevCount = workspaces.length;
      const pollInterval = setInterval(async () => {
        try {
          const wsRes = await fetch("/api/slack/workspaces");
          const wsData = await wsRes.json();
          const newCount = wsData.workspaces?.length ?? 0;
          if (newCount > prevCount) {
            clearInterval(pollInterval);
            addToast("Workspace authorized successfully", "success");
            await loadData();
          }
        } catch {
          // Ignore polling errors
        }
      }, 3000);
      // Stop polling after 2 minutes
      setTimeout(() => clearInterval(pollInterval), 120000);
    } catch (err) {
      console.error("Failed to start OAuth:", err);
      addToast("Failed to start OAuth flow", "error");
    } finally {
      setAuthorizing(false);
    }
  };

  const startBrowserAuth = async () => {
    setBrowserAuth(true);
    try {
      const res = await fetch("/api/slack/browser-auth", { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        addToast(data.error ?? "Failed to launch browser", "error");
        setBrowserAuth(false);
        return;
      }
      addToast("Browser opened — sign in to Slack", "success");
      // Poll for new workspaces
      const prevCount = workspaces.length;
      const pollInterval = setInterval(async () => {
        try {
          const wsRes = await fetch("/api/slack/workspaces");
          const wsData = await wsRes.json();
          const newCount = wsData.workspaces?.length ?? 0;
          if (newCount > prevCount) {
            clearInterval(pollInterval);
            addToast("Workspace connected successfully", "success");
            setBrowserAuth(false);
            // Also check if browser auth process is done
            try {
              await fetch("/api/slack/browser-auth", { method: "DELETE" });
            } catch {}
            // Reload the page to pick up all changes
            window.location.reload();
          }
        } catch {
          // Ignore polling errors
        }
      }, 3000);
      // Stop polling after 3 minutes
      setTimeout(() => {
        clearInterval(pollInterval);
        setBrowserAuth(false);
      }, 180000);
    } catch (err) {
      console.error("Failed to start browser auth:", err);
      addToast("Failed to launch browser", "error");
      setBrowserAuth(false);
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
      // Reload workspaces — test updates team name in DB if it was "unknown"
      if (data.ok) {
        await loadData();
      }
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
      <div className="flex items-center gap-3 mb-8">
        <p className="text-sm text-overlay0">Manage Slack workspace connections and tokens</p>
        <div className="flex items-center gap-2">
          <a
            href="https://api.slack.com/apps"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue hover:text-blue/80"
          >
            Slack Apps <ExternalLink size={10} />
          </a>
          <span className="text-overlay0">·</span>
          <a
            href="https://api.slack.com/tutorials/tracks/getting-a-token"
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
          <div className="flex items-center justify-between">
            <span className="text-sm text-text">OAuth Credentials</span>
            <StatusBadge
              status={hasOAuthCreds ? "connected" : "not_configured"}
              label={hasOAuthCreds ? "Configured" : "Not set"}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-text">Connected Workspaces</span>
            <StatusBadge
              status={workspaces.length > 0 ? "connected" : "not_configured"}
              label={workspaces.length > 0 ? `${workspaces.length} connected` : "None"}
            />
          </div>
        </div>
      </section>

      {/* Default Notification Channel */}
      {workspaces.length > 0 && (
        <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
          <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
            Default Notification Channel
          </h2>
          <p className="text-xs text-overlay0 mb-3">
            Where the agent sends summaries, alerts, and scheduled task results. Defaults to DM with
            the connected user.
          </p>
          {notifDefault ? (
            <div className="flex items-center justify-between rounded-lg border border-surface0 bg-base p-3 mb-3">
              <div className="flex items-center gap-2">
                <Bell size={14} className="text-mauve shrink-0" />
                <div>
                  <p className="text-sm font-medium text-text">
                    {notifDefault.label ?? notifDefault.channelId}
                  </p>
                  <p className="text-xs text-overlay0">
                    {notifDefault.platform} / {notifDefault.channelId}
                  </p>
                </div>
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={async () => {
                    try {
                      await fetch("/api/notifications", { method: "DELETE" });
                      setNotifDefault(null);
                      addToast("Notification default cleared", "success");
                    } catch {
                      addToast("Failed to clear notification default", "error");
                    }
                  }}
                  className="p-1.5 rounded-md text-overlay0 hover:text-red hover:bg-surface0 transition-colors"
                  title="Clear default"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-yellow mb-3">
              No default set — the agent will auto-set this to your DM on next daemon start.
            </p>
          )}
          {workspaces.length > 0 && !notifDefault && (
            <button
              disabled={savingNotif}
              onClick={async () => {
                setSavingNotif(true);
                const ws = workspaces[0];
                const nd = {
                  platform: `slack-user:${ws.team_id}`,
                  channelId: ws.user_id,
                  label: `DM in ${ws.team_name}`,
                };
                try {
                  const res = await fetch("/api/notifications", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(nd),
                  });
                  if (res.ok) {
                    setNotifDefault(nd);
                    addToast("Notification default set to DM", "success");
                  } else {
                    addToast("Failed to set notification default", "error");
                  }
                } catch {
                  addToast("Failed to set notification default", "error");
                } finally {
                  setSavingNotif(false);
                }
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-60"
            >
              <Bell size={14} />
              Set to DM with me
            </button>
          )}
        </section>
      )}

      {/* Connected Workspaces */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Connected Workspaces
        </h2>
        {workspaces.length > 0 ? (
          <div className="space-y-2 mb-4">
            {workspaces.map((ws) => (
              <div
                key={ws.team_id}
                className="flex items-center justify-between rounded-lg border border-surface0 bg-base p-3"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <KeyRound size={14} className="text-green shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">{ws.team_name}</p>
                    <p className="text-xs text-overlay0">
                      {ws.team_id} · User: {ws.user_id} · Connected:{" "}
                      {new Date(ws.created_at).toLocaleDateString()}
                    </p>
                    {testResults[ws.team_id] && (
                      <p
                        className={`text-xs mt-1 ${
                          testResults[ws.team_id].ok ? "text-green" : "text-red"
                        }`}
                      >
                        {testResults[ws.team_id].message}
                      </p>
                    )}
                  </div>
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
        ) : (
          <p className="text-sm text-overlay0 mb-4">
            No workspaces connected yet. Use OAuth to authorize a workspace.
          </p>
        )}

        {/* Authorize via OAuth (primary) */}
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={startOAuth}
            disabled={!hasOAuthCreds || authorizing}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {authorizing ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
            {authorizing ? "Waiting for authorization..." : "Authorize Workspace"}
          </button>
          {!hasOAuthCreds && (
            <span className="text-xs text-overlay0">Requires OAuth credentials below</span>
          )}
        </div>
        <p className="text-xs text-overlay0 mb-4">
          Opens Slack OAuth in your browser. Requires Client ID &amp; Secret configured below.
        </p>

        {/* Sign in via Browser (experimental — enabled via NOMOS_BROWSER_AUTH) */}
        {browserAuthEnabled && (
          <>
            <div className="flex items-center gap-3">
              <button
                onClick={startBrowserAuth}
                disabled={browserAuth}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface0 border border-surface1 text-sm text-subtext0 hover:text-text hover:border-surface2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {browserAuth ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Globe size={14} />
                )}
                {browserAuth ? "Waiting for sign-in..." : "Sign in via Browser"}
              </button>
            </div>
            <p className="text-xs text-overlay0 mt-3">
              Experimental: Opens a browser window to capture tokens automatically. No Slack app
              required.
            </p>
          </>
        )}
      </section>

      {/* Manual Token (collapsible alternative) */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Manual Token
        </h2>
        <p className="text-xs text-overlay0 mb-3">
          Alternative to OAuth — paste a user token directly if you already have one.
        </p>
        <div className="space-y-3">
          <TokenInput
            label="User Token"
            value={newToken}
            onChange={setNewToken}
            placeholder="xoxp-..."
            helperText="Slack user token (xoxp-) from OAuth & Permissions page"
          />
          <button
            onClick={connectWorkspace}
            disabled={!newToken.trim() || connecting}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {connecting ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
            Connect
          </button>
        </div>
      </section>

      {/* App Configuration */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider">
            App Configuration
          </h2>
          <a
            href="https://api.slack.com/apps"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue hover:text-blue/80"
          >
            Slack App Settings <ExternalLink size={10} />
          </a>
        </div>
        <div className="space-y-4">
          <TokenInput
            label="Client ID"
            value={clientId}
            onChange={(v) => {
              setClientId(v);
              setClientIdDirty(true);
            }}
            placeholder={
              hasClientId ? "Configured - enter new value to replace" : "Your app's Client ID"
            }
            helperText="From Basic Information → App Credentials. Required for OAuth workspace authorization."
            configured={hasClientId}
          />
          <TokenInput
            label="Client Secret"
            value={clientSecret}
            onChange={(v) => {
              setClientSecret(v);
              setClientSecretDirty(true);
            }}
            placeholder={
              hasClientSecret
                ? "Configured - enter new value to replace"
                : "Your app's Client Secret"
            }
            helperText="From Basic Information → App Credentials"
            configured={hasClientSecret}
          />
          <TokenInput
            label="App Token"
            value={appToken}
            onChange={(v) => {
              setAppToken(v);
              setAppTokenDirty(true);
            }}
            placeholder={hasAppToken ? "Configured - enter new value to replace" : "xapp-..."}
            helperText="Required for Socket Mode. Generate at Basic Information → App-Level Tokens (scope: connections:write)"
            configured={hasAppToken}
          />
          <TokenInput
            label="Bot Token (optional)"
            value={botToken}
            onChange={(v) => {
              setBotToken(v);
              setBotTokenDirty(true);
            }}
            placeholder={hasBotToken ? "Configured - enter new value to replace" : "xoxb-..."}
            helperText="Optional — only needed for bot mode and draft approval notifications"
            configured={hasBotToken}
          />
          <button
            onClick={saveTokens}
            disabled={saving || !isDirty}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving && <RefreshCw size={14} className="animate-spin" />}
            Save
          </button>
        </div>
      </section>

      {/* Sync Progress */}
      {workspaces.length > 0 && <SyncProgress platform="slack" />}

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
