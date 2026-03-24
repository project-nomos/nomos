"use client";

import { useState } from "react";
import {
  MessageSquare,
  MessageCircle,
  Send,
  Mail,
  Phone,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  CheckCircle,
} from "lucide-react";

interface ChannelsStepProps {
  onComplete: () => void;
}

interface ChannelConfig {
  id: string;
  label: string;
  icon: React.ComponentType<{ size: number; className?: string }>;
  color: string;
  fields: {
    key: string;
    label: string;
    placeholder: string;
    secret?: boolean;
  }[];
}

const CHANNELS: ChannelConfig[] = [
  {
    id: "slack",
    label: "Slack",
    icon: MessageSquare,
    color: "text-blue",
    fields: [
      { key: "SLACK_APP_TOKEN", label: "App Token", placeholder: "xapp-...", secret: true },
      { key: "SLACK_BOT_TOKEN", label: "Bot Token", placeholder: "xoxb-...", secret: true },
    ],
  },
  {
    id: "discord",
    label: "Discord",
    icon: MessageCircle,
    color: "text-lavender",
    fields: [
      {
        key: "DISCORD_BOT_TOKEN",
        label: "Bot Token",
        placeholder: "Discord bot token",
        secret: true,
      },
      {
        key: "DISCORD_ALLOWED_GUILDS",
        label: "Allowed Guilds",
        placeholder: "Guild IDs (comma-separated)",
      },
    ],
  },
  {
    id: "telegram",
    label: "Telegram",
    icon: Send,
    color: "text-teal",
    fields: [
      {
        key: "TELEGRAM_BOT_TOKEN",
        label: "Bot Token",
        placeholder: "123456:ABC-...",
        secret: true,
      },
      {
        key: "TELEGRAM_ALLOWED_CHATS",
        label: "Allowed Chats",
        placeholder: "Chat IDs (comma-separated)",
      },
    ],
  },
  {
    id: "google",
    label: "Google Workspace",
    icon: Mail,
    color: "text-peach",
    fields: [
      {
        key: "GOOGLE_OAUTH_CLIENT_ID",
        label: "OAuth Client ID",
        placeholder: "...apps.googleusercontent.com",
      },
      {
        key: "GOOGLE_OAUTH_CLIENT_SECRET",
        label: "OAuth Client Secret",
        placeholder: "GOCSPX-...",
        secret: true,
      },
    ],
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    icon: Phone,
    color: "text-green",
    fields: [{ key: "WHATSAPP_ENABLED", label: "Enable WhatsApp", placeholder: "true" }],
  },
];

function ChannelCard({
  channel,
  values,
  onChange,
}: {
  channel: ChannelConfig;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [visibleFields, setVisibleFields] = useState<Set<string>>(new Set());
  const hasValues = channel.fields.some((f) => values[f.key]?.length > 0);
  const Icon = channel.icon;

  return (
    <div className="rounded-xl border border-surface0 bg-mantle overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-4 hover:bg-surface0/50 transition-colors"
      >
        <div
          className={`w-8 h-8 rounded-lg bg-surface0 flex items-center justify-center ${channel.color} shrink-0`}
        >
          <Icon size={16} />
        </div>
        <span className="text-sm font-medium text-text flex-1 text-left">{channel.label}</span>
        {hasValues && <span className="w-2 h-2 rounded-full bg-green shrink-0" />}
        {expanded ? (
          <ChevronDown size={14} className="text-overlay0" />
        ) : (
          <ChevronRight size={14} className="text-overlay0" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-surface0 pt-3">
          {channel.fields.map((field) => (
            <div key={field.key} className="space-y-1">
              <label className="block text-xs font-medium text-subtext0">{field.label}</label>
              <div className="relative">
                <input
                  type={field.secret && !visibleFields.has(field.key) ? "password" : "text"}
                  value={values[field.key] || ""}
                  onChange={(e) => onChange(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  className="w-full rounded-lg border border-surface1 bg-surface0 px-3 py-2 text-sm text-text placeholder:text-overlay0 focus:outline-none focus:border-mauve focus:ring-1 focus:ring-mauve/30 font-mono pr-9"
                />
                {field.secret && (
                  <button
                    type="button"
                    onClick={() => {
                      const next = new Set(visibleFields);
                      if (next.has(field.key)) next.delete(field.key);
                      else next.add(field.key);
                      setVisibleFields(next);
                    }}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-overlay0 hover:text-text transition-colors"
                  >
                    {visibleFields.has(field.key) ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChannelsStep({ onComplete }: ChannelsStepProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const hasAnyValues = Object.values(values).some((v) => v.length > 0);

  const handleChange = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSuccess(false);
  };

  const save = async () => {
    if (!hasAnyValues) {
      onComplete();
      return;
    }

    setSaving(true);
    try {
      // Filter to non-empty values only
      const updates: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        if (value.trim()) {
          updates[key] = value.trim();
        }
      }

      if (Object.keys(updates).length > 0) {
        await fetch("/api/env", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        });
      }

      setSuccess(true);
      setTimeout(onComplete, 600);
    } catch {
      // Non-fatal — channels are optional
      onComplete();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-green/10 border border-green/20 flex items-center justify-center">
          <MessageSquare size={20} className="text-green" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-text">Channels</h2>
          <p className="text-sm text-overlay0">Connect messaging platforms (optional)</p>
        </div>
      </div>

      <p className="text-xs text-overlay0">
        You can skip this step and configure channels later from the integrations page.
      </p>

      <div className="space-y-2">
        {CHANNELS.map((channel) => (
          <ChannelCard key={channel.id} channel={channel} values={values} onChange={handleChange} />
        ))}
      </div>

      {success && (
        <div className="flex items-center gap-2 rounded-lg bg-green/10 border border-green/20 p-3">
          <CheckCircle size={16} className="text-green" />
          <p className="text-sm text-green">Channels saved</p>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onComplete}
          className="flex-1 px-4 py-2.5 rounded-lg border border-surface1 text-sm font-medium text-subtext0 hover:text-text hover:border-surface2 transition-colors"
        >
          Skip for now
        </button>
        <button
          onClick={save}
          disabled={saving || success || !hasAnyValues}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Saving...
            </>
          ) : (
            "Save & Continue"
          )}
        </button>
      </div>
    </div>
  );
}
