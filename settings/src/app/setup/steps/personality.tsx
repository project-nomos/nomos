"use client";

import { useState } from "react";
import { User, Loader2, CheckCircle, AlertCircle } from "lucide-react";

interface PersonalityStepProps {
  onComplete: () => void;
}

export function PersonalityStep({ onComplete }: PersonalityStepProps) {
  const [agentName, setAgentName] = useState("Nomos");
  const [agentEmoji, setAgentEmoji] = useState("");
  const [agentPurpose, setAgentPurpose] = useState("");
  const [userName, setUserName] = useState("");
  const [timezone, setTimezone] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "";
    }
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const save = async () => {
    if (!agentName.trim()) {
      setError("Agent name is required");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const configUpdates: Record<string, string> = {
        "agent.name": agentName.trim(),
      };
      if (agentEmoji) configUpdates["agent.emoji"] = agentEmoji;
      if (agentPurpose) configUpdates["agent.purpose"] = agentPurpose.trim();
      if (userName) configUpdates["user.name"] = userName.trim();
      if (timezone) configUpdates["user.timezone"] = timezone;

      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(configUpdates),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to save");
        return;
      }

      setSuccess(true);
      setTimeout(onComplete, 600);
    } catch {
      setError("Failed to save configuration");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-peach/10 border border-peach/20 flex items-center justify-center">
          <User size={20} className="text-peach" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-text">Personality</h2>
          <p className="text-sm text-overlay0">Give your assistant an identity</p>
        </div>
      </div>

      {/* Agent Identity */}
      <div className="rounded-xl border border-surface0 bg-mantle p-4 space-y-4">
        <span className="text-xs font-semibold text-overlay0 uppercase tracking-wider">
          Your Assistant
        </span>

        <div className="flex gap-3">
          <div className="flex-1 space-y-1.5">
            <label className="block text-sm font-medium text-subtext1">Name</label>
            <input
              type="text"
              value={agentName}
              onChange={(e) => {
                setAgentName(e.target.value);
                setError(null);
                setSuccess(false);
              }}
              placeholder="Nomos"
              className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2.5 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30"
            />
          </div>
          <div className="w-20 space-y-1.5">
            <label className="block text-sm font-medium text-subtext1">Icon</label>
            <input
              type="text"
              value={agentEmoji}
              onChange={(e) => setAgentEmoji(e.target.value)}
              placeholder="--"
              maxLength={4}
              className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2.5 text-sm text-text text-center placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-subtext1">Purpose</label>
          <textarea
            value={agentPurpose}
            onChange={(e) => setAgentPurpose(e.target.value)}
            placeholder="A helpful AI assistant that manages my projects, answers questions, and helps with daily tasks..."
            rows={3}
            className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2.5 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 resize-none"
          />
          <p className="text-xs text-overlay0">
            Describes what your assistant does. Shapes how it responds and what it focuses on.
          </p>
        </div>
      </div>

      {/* User Info */}
      <div className="rounded-xl border border-surface0 bg-mantle p-4 space-y-4">
        <span className="text-xs font-semibold text-overlay0 uppercase tracking-wider">
          About You (optional)
        </span>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-subtext1">Your Name</label>
          <input
            type="text"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="How should the assistant address you?"
            className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2.5 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30"
          />
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-subtext1">Timezone</label>
          <input
            type="text"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="America/New_York"
            className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2.5 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono"
          />
          <p className="text-xs text-overlay0">Auto-detected from your browser</p>
        </div>
      </div>

      {/* Preview */}
      {agentName && (
        <div className="rounded-lg border border-surface0 bg-crust p-3 text-center">
          <span className="text-lg">{agentEmoji && `${agentEmoji} `}</span>
          <span className="text-sm font-medium text-text">{agentName}</span>
          {userName && <p className="text-xs text-overlay0 mt-1">Assistant for {userName}</p>}
        </div>
      )}

      {/* Status */}
      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-red/10 border border-red/20 p-3">
          <AlertCircle size={16} className="text-red mt-0.5 shrink-0" />
          <p className="text-sm text-red">{error}</p>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 rounded-lg bg-green/10 border border-green/20 p-3">
          <CheckCircle size={16} className="text-green" />
          <p className="text-sm text-green">Identity saved</p>
        </div>
      )}

      {/* Action */}
      <button
        onClick={save}
        disabled={saving || !agentName.trim() || success}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {saving ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Saving...
          </>
        ) : success ? (
          <>
            <CheckCircle size={16} />
            Saved
          </>
        ) : (
          "Save & Continue"
        )}
      </button>
    </div>
  );
}
