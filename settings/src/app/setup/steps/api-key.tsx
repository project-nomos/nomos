"use client";

import { useState } from "react";
import {
  Key,
  CheckCircle,
  AlertCircle,
  Loader2,
  ExternalLink,
  Eye,
  EyeOff,
  Cloud,
} from "lucide-react";

interface ApiKeyStepProps {
  onComplete: () => void;
}

const MODELS = [
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", description: "Fast and capable" },
  { value: "claude-opus-4-6", label: "Claude Opus 4.6", description: "Most powerful" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", description: "Fastest, most efficient" },
];

const VERTEX_REGIONS = [
  "us-east5",
  "us-central1",
  "europe-west1",
  "europe-west4",
  "asia-southeast1",
];

export function ApiKeyStep({ onComplete }: ApiKeyStepProps) {
  const [provider, setProvider] = useState<"anthropic" | "vertex">("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [gcpProject, setGcpProject] = useState("");
  const [gcpRegion, setGcpRegion] = useState("us-east5");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [visible, setVisible] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const validate = async () => {
    setValidating(true);
    setError(null);
    setWarning(null);
    setSuccess(false);

    try {
      // Validate the key
      const validateRes = await fetch("/api/setup/validate-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          provider === "anthropic"
            ? { provider: "anthropic", apiKey }
            : { provider: "vertex", projectId: gcpProject, region: gcpRegion },
        ),
      });

      const validateData = await validateRes.json();
      if (!validateData.valid) {
        setError(validateData.error || "Validation failed");
        setValidating(false);
        return;
      }
      if (validateData.warning) {
        setWarning(validateData.warning);
      }

      // Save to env
      const envUpdates: Record<string, string> = { NOMOS_MODEL: model };
      if (provider === "anthropic") {
        envUpdates.ANTHROPIC_API_KEY = apiKey;
        envUpdates.CLAUDE_CODE_USE_VERTEX = "";
      } else {
        envUpdates.CLAUDE_CODE_USE_VERTEX = "1";
        envUpdates.GOOGLE_CLOUD_PROJECT = gcpProject;
        envUpdates.CLOUD_ML_REGION = gcpRegion;
      }

      await fetch("/api/env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envUpdates),
      });

      setSuccess(true);
      setTimeout(onComplete, 800);
    } catch {
      setError("Failed to validate");
    } finally {
      setValidating(false);
    }
  };

  const canSubmit = provider === "anthropic" ? apiKey.length > 0 : gcpProject.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-mauve/10 border border-mauve/20 flex items-center justify-center">
          <Key size={20} className="text-mauve" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-text">API Provider</h2>
          <p className="text-sm text-overlay0">How to connect to Claude</p>
        </div>
      </div>

      {/* Provider Toggle */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            setProvider("anthropic");
            setError(null);
            setSuccess(false);
          }}
          className={`flex-1 flex items-center gap-2 px-4 py-3 rounded-lg border text-sm font-medium transition-colors ${
            provider === "anthropic"
              ? "border-mauve/50 bg-mauve/5 text-text"
              : "border-surface0 bg-mantle text-overlay0 hover:border-surface1"
          }`}
        >
          <Key size={16} />
          Anthropic API
        </button>
        <button
          type="button"
          onClick={() => {
            setProvider("vertex");
            setError(null);
            setSuccess(false);
          }}
          className={`flex-1 flex items-center gap-2 px-4 py-3 rounded-lg border text-sm font-medium transition-colors ${
            provider === "vertex"
              ? "border-mauve/50 bg-mauve/5 text-text"
              : "border-surface0 bg-mantle text-overlay0 hover:border-surface1"
          }`}
        >
          <Cloud size={16} />
          Vertex AI
        </button>
      </div>

      {/* Provider-specific fields */}
      {provider === "anthropic" ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-sm font-medium text-subtext1">API Key</label>
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue hover:text-blue/80"
            >
              Get a key <ExternalLink size={10} />
            </a>
          </div>
          <div className="relative">
            <input
              type={visible ? "text" : "password"}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setError(null);
                setSuccess(false);
              }}
              placeholder="sk-ant-..."
              className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2.5 pr-10 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
            />
            <button
              type="button"
              onClick={() => setVisible(!visible)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-overlay0 hover:text-text transition-colors"
            >
              {visible ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-subtext1">GCP Project ID</label>
            <input
              type="text"
              value={gcpProject}
              onChange={(e) => {
                setGcpProject(e.target.value);
                setError(null);
                setSuccess(false);
              }}
              placeholder="my-project-12345"
              className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2.5 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
            />
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-subtext1">Region</label>
            <select
              value={gcpRegion}
              onChange={(e) => setGcpRegion(e.target.value)}
              className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2.5 text-sm text-text focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30"
            >
              {VERTEX_REGIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="rounded-lg bg-yellow/10 border border-yellow/20 p-3">
            <p className="text-xs text-yellow">
              Requires{" "}
              <code className="bg-surface0 px-1 rounded text-xs">
                gcloud auth application-default login
              </code>{" "}
              for authentication.
            </p>
          </div>
        </div>
      )}

      {/* Model Selection */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-subtext1">Model</label>
        <div className="space-y-1.5">
          {MODELS.map((m) => (
            <label
              key={m.value}
              className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                model === m.value
                  ? "border-mauve/50 bg-mauve/5"
                  : "border-surface0 bg-mantle hover:border-surface1"
              }`}
            >
              <input
                type="radio"
                name="model"
                value={m.value}
                checked={model === m.value}
                onChange={(e) => setModel(e.target.value)}
                className="accent-mauve"
              />
              <div>
                <span className="text-sm font-medium text-text">{m.label}</span>
                <p className="text-xs text-overlay0">{m.description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Status */}
      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-red/10 border border-red/20 p-3">
          <AlertCircle size={16} className="text-red mt-0.5 shrink-0" />
          <p className="text-sm text-red">{error}</p>
        </div>
      )}

      {warning && !error && (
        <div className="flex items-start gap-2 rounded-lg bg-yellow/10 border border-yellow/20 p-3">
          <AlertCircle size={16} className="text-yellow mt-0.5 shrink-0" />
          <p className="text-sm text-yellow">{warning}</p>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 rounded-lg bg-green/10 border border-green/20 p-3">
          <CheckCircle size={16} className="text-green" />
          <p className="text-sm text-green">API configured</p>
        </div>
      )}

      {/* Action */}
      <button
        onClick={validate}
        disabled={validating || !canSubmit || success}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {validating ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Validating...
          </>
        ) : success ? (
          <>
            <CheckCircle size={16} />
            Configured
          </>
        ) : (
          "Validate & Save"
        )}
      </button>
    </div>
  );
}
