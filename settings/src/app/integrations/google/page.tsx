"use client";

import { useEffect, useState, useCallback } from "react";
import { RefreshCw, ExternalLink, Plus, Trash2, KeyRound, Check } from "lucide-react";
import { TokenInput } from "@/components/token-input";
import { StatusBadge } from "@/components/status-badge";
import { DirtyIndicator } from "@/components/dirty-indicator";
import { ConfirmModal } from "@/components/confirm-modal";
import { useToast } from "@/contexts/toast-context";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";

const ALL_SERVICES = [
  "drive", "gmail", "calendar", "docs", "sheets", "slides",
  "tasks", "people", "chat", "forms", "keep", "meet",
];

interface GwsAccount {
  email: string;
  default: boolean;
}

export default function GoogleSettingsPage() {
  const { addToast } = useToast();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [hasClientId, setHasClientId] = useState(false);
  const [hasClientSecret, setHasClientSecret] = useState(false);
  const [clientIdDirty, setClientIdDirty] = useState(false);
  const [clientSecretDirty, setClientSecretDirty] = useState(false);
  const [services, setServices] = useState("all");
  const [initialServices, setInitialServices] = useState("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  // gws status
  const [gwsInstalled, setGwsInstalled] = useState(false);
  const [gwsVersion, setGwsVersion] = useState("");

  // Authorized accounts state
  const [accounts, setAccounts] = useState<GwsAccount[]>([]);
  const [authorizing, setAuthorizing] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const isDirty =
    clientIdDirty ||
    clientSecretDirty ||
    services !== initialServices;
  useUnsavedChanges(isDirty);

  const selectedServices = services === "all"
    ? ALL_SERVICES
    : services.split(",").map((s) => s.trim()).filter(Boolean);

  const isAllServices = services === "all";

  const loadAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/google/accounts");
      const data = await res.json();
      setAccounts(data.accounts ?? []);
    } catch (err) {
      console.error("Failed to load authorized accounts:", err);
    }
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [statusRes, envRes] = await Promise.all([
        fetch("/api/google/status"),
        fetch("/api/env"),
      ]);
      const statusData = await statusRes.json();
      const envData = await envRes.json();

      setHasClientId(!!envData.GOOGLE_OAUTH_CLIENT_ID);
      setHasClientSecret(!!envData.GOOGLE_OAUTH_CLIENT_SECRET);
      setClientId("");
      setClientSecret("");
      setClientIdDirty(false);
      setClientSecretDirty(false);
      setGwsInstalled(statusData.gwsInstalled ?? false);
      setGwsVersion(statusData.gwsVersion ?? "");
      setAccounts(statusData.accounts ?? []);
      setServices(statusData.services ?? "all");
      setInitialServices(statusData.services ?? "all");
    } catch (err) {
      console.error("Failed to load Google data:", err);
      addToast("Failed to load Google data", "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadData();
    loadAccounts();
  }, [loadData, loadAccounts]);

  const saveCredentials = async () => {
    setSaving(true);
    try {
      const updates: Record<string, string> = {};
      if (clientIdDirty) updates.GOOGLE_OAUTH_CLIENT_ID = clientId;
      if (clientSecretDirty) updates.GOOGLE_OAUTH_CLIENT_SECRET = clientSecret;
      updates.GWS_SERVICES = services;

      const res = await fetch("/api/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      if (!res.ok) {
        const data = await res.json();
        addToast(data.error ?? "Failed to save credentials", "error");
        return;
      }

      addToast("Settings saved successfully", "success");
      await loadData();
    } catch (err) {
      console.error("Failed to save credentials:", err);
      addToast("Failed to save credentials", "error");
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTestResult({ ok: false, message: "Testing..." });
    try {
      const res = await fetch("/api/google/test", { method: "POST" });
      const data = await res.json();
      setTestResult({ ok: data.ok, message: data.message });
      if (data.ok) {
        addToast("Connection test passed", "success");
      } else {
        addToast(data.message, "error");
      }
    } catch {
      setTestResult({ ok: false, message: "Test failed" });
      addToast("Connection test failed", "error");
    }
  };

  const startOAuth = async () => {
    setAuthorizing(true);
    try {
      const res = await fetch("/api/google/oauth/start", { method: "POST" });
      const data = await res.json();
      if (data.error) {
        addToast(data.error, "error");
        return;
      }
      if (data.url) {
        window.open(data.url, "_blank");
        addToast("Google authorization opened — complete sign-in in the new tab", "success");
      } else {
        addToast("Authorization started", "success");
      }
      // Poll for new accounts
      const pollInterval = setInterval(async () => {
        await loadAccounts();
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

  const removeAccount = async (email: string) => {
    try {
      const res = await fetch("/api/google/accounts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json();
        addToast(data.error ?? "Failed to remove account", "error");
        return;
      }
      addToast(`Removed ${email}`, "success");
      await loadAccounts();
    } catch (err) {
      console.error("Failed to remove account:", err);
      addToast("Failed to remove account", "error");
    } finally {
      setRemoveTarget(null);
    }
  };

  const toggleService = (service: string) => {
    if (isAllServices) {
      // Switch to specific services, removing this one
      const newServices = ALL_SERVICES.filter((s) => s !== service);
      setServices(newServices.join(","));
    } else {
      const current = selectedServices;
      if (current.includes(service)) {
        const filtered = current.filter((s) => s !== service);
        setServices(filtered.length > 0 ? filtered.join(",") : "all");
      } else {
        const updated = [...current, service];
        if (updated.length === ALL_SERVICES.length) {
          setServices("all");
        } else {
          setServices(updated.join(","));
        }
      }
    }
  };

  const toggleAllServices = () => {
    setServices(isAllServices ? "" : "all");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-mauve border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const isConfigured = hasClientId && hasClientSecret;

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-1">
        <h1 className="text-2xl font-bold text-text">Google Workspace</h1>
        <DirtyIndicator isDirty={isDirty} />
      </div>
      <p className="text-sm text-overlay0 mb-8">
        Google Workspace integration via gws CLI
      </p>

      {/* Connection Status */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Connection Status
        </h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-text">gws CLI</span>
            <StatusBadge
              status={gwsInstalled ? "connected" : "not_configured"}
              label={gwsInstalled ? `v${gwsVersion}` : "Not found"}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-text">OAuth Credentials</span>
            <StatusBadge
              status={isConfigured ? "connected" : "not_configured"}
              label={isConfigured ? "Configured" : "Missing"}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-text">Authorized Accounts</span>
            <span className="text-xs text-overlay0">
              {accounts.length > 0
                ? `${accounts.length} authorized`
                : "None authorized"}
            </span>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <span className="text-xs text-overlay0">Services:</span>
            <span className={`text-xs px-2 py-0.5 rounded-md ${
              gwsInstalled && accounts.length > 0
                ? "bg-green/10 text-green"
                : "bg-surface0 text-overlay0"
            }`}>
              {isAllServices ? "All services" : `${selectedServices.length} selected`}
            </span>
          </div>
        </div>
      </section>

      {/* Authorized Accounts */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Authorized Accounts
        </h2>
        {accounts.length > 0 ? (
          <div className="space-y-2 mb-4">
            {accounts.map((account) => (
              <div
                key={account.email}
                className="flex items-center justify-between rounded-lg border border-surface0 bg-base px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <KeyRound size={14} className="text-green shrink-0" />
                  <div className="min-w-0">
                    <span className="text-sm text-text block truncate">{account.email}</span>
                    {account.default && (
                      <span className="text-xs text-overlay0">default</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setRemoveTarget(account.email)}
                  className="p-1 rounded text-overlay0 hover:text-red transition-colors shrink-0 ml-2"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-overlay0 mb-4">
            No Google accounts authorized yet. Configure OAuth credentials below, then click Authorize.
          </p>
        )}
        <div className="flex items-center gap-3">
          <button
            onClick={startOAuth}
            disabled={!isConfigured || authorizing}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface0 border border-surface1 text-sm text-subtext0 hover:text-text hover:border-surface2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {authorizing ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
            Authorize New Account
          </button>
          {!isConfigured && (
            <span className="text-xs text-overlay0">
              Configure OAuth credentials first
            </span>
          )}
        </div>
        <p className="text-xs text-overlay0 mt-3">
          Opens Google consent screen in a new tab. Complete sign-in there to authorize access.
        </p>
      </section>

      {/* OAuth Credentials */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider">
            OAuth Credentials
          </h2>
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue hover:text-blue/80"
          >
            Google Cloud Console <ExternalLink size={10} />
          </a>
        </div>
        <div className="space-y-4">
          <TokenInput
            label="Client ID"
            value={clientId}
            onChange={(v) => { setClientId(v); setClientIdDirty(true); }}
            placeholder={hasClientId ? "Configured - enter new value to replace" : "...apps.googleusercontent.com"}
            helperText="OAuth 2.0 Desktop Client ID"
          />
          <TokenInput
            label="Client Secret"
            value={clientSecret}
            onChange={(v) => { setClientSecret(v); setClientSecretDirty(true); }}
            placeholder={hasClientSecret ? "Configured - enter new value to replace" : "GOCSPX-..."}
            helperText="OAuth 2.0 Client Secret"
          />
        </div>
      </section>

      {/* Services Selector */}
      <section className="mb-8 rounded-xl border border-surface0 bg-mantle p-5">
        <h2 className="text-sm font-semibold text-subtext1 uppercase tracking-wider mb-4">
          Services
        </h2>
        <p className="text-xs text-overlay0 mb-3">
          Select which Google Workspace services to expose via MCP tools.
        </p>
        <label
          className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors mb-3 ${
            isAllServices
              ? "border-mauve/50 bg-mauve/5"
              : "border-surface0 bg-base hover:border-surface1"
          }`}
        >
          <button
            type="button"
            onClick={toggleAllServices}
            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
              isAllServices
                ? "bg-mauve border-mauve text-crust"
                : "border-surface1 bg-surface0"
            }`}
          >
            {isAllServices && <Check size={12} />}
          </button>
          <div>
            <span className="text-sm font-medium text-text">All services</span>
            <p className="text-xs text-overlay0">Enable all Google Workspace APIs</p>
          </div>
        </label>
        <div className="grid grid-cols-3 gap-2">
          {ALL_SERVICES.map((service) => {
            const isSelected = isAllServices || selectedServices.includes(service);
            return (
              <button
                key={service}
                type="button"
                onClick={() => toggleService(service)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                  isSelected
                    ? "border-mauve/30 bg-mauve/5 text-text"
                    : "border-surface0 bg-base text-overlay0 hover:border-surface1"
                }`}
              >
                <div className={`w-3 h-3 rounded-sm border flex items-center justify-center ${
                  isSelected
                    ? "bg-mauve border-mauve text-crust"
                    : "border-surface1"
                }`}>
                  {isSelected && <Check size={8} />}
                </div>
                {service}
              </button>
            );
          })}
        </div>
      </section>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={saveCredentials}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving && <RefreshCw size={14} className="animate-spin" />}
          Save to .env
        </button>
        <button
          onClick={testConnection}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface0 border border-surface1 text-sm text-subtext0 hover:text-text hover:border-surface2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Test Connection
        </button>
        {testResult && (
          <span
            className={`text-xs ${testResult.ok ? "text-green" : "text-red"}`}
          >
            {testResult.message}
          </span>
        )}
      </div>

      {/* Remove Account Confirm Modal */}
      <ConfirmModal
        isOpen={!!removeTarget}
        title="Remove Authorized Account"
        message={`This will log out ${removeTarget} from gws. The account will need to be re-authorized to use Google Workspace tools.`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => removeTarget && removeAccount(removeTarget)}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}
