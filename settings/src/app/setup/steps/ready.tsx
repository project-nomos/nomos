"use client";

import Link from "next/link";
import { CheckCircle, Settings, ArrowRight, Database, Key, User, MessageSquare } from "lucide-react";

interface ReadyStepProps {
  checks: {
    database: boolean;
    apiKey: boolean;
    agentName: boolean;
  };
}

const SUMMARY_ITEMS = [
  { key: "database" as const, label: "Database connected", icon: Database },
  { key: "apiKey" as const, label: "API provider configured", icon: Key },
  { key: "agentName" as const, label: "Identity set up", icon: User },
];

export function ReadyStep({ checks }: ReadyStepProps) {
  return (
    <div className="space-y-6 text-center">
      {/* Success Icon */}
      <div className="flex justify-center">
        <div className="w-16 h-16 rounded-2xl bg-green/10 border border-green/20 flex items-center justify-center">
          <CheckCircle size={32} className="text-green" />
        </div>
      </div>

      <div>
        <h2 className="text-xl font-bold text-text mb-2">You{"'"}re all set</h2>
        <p className="text-sm text-overlay0">
          Your assistant is configured and ready to use.
        </p>
      </div>

      {/* Summary */}
      <div className="rounded-xl border border-surface0 bg-mantle p-4 text-left">
        <div className="space-y-3">
          {SUMMARY_ITEMS.map((item) => {
            const Icon = item.icon;
            const done = checks[item.key];
            return (
              <div key={item.key} className="flex items-center gap-3">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center ${
                    done
                      ? "bg-green/10 text-green"
                      : "bg-surface0 text-overlay0"
                  }`}
                >
                  {done ? <CheckCircle size={14} /> : <Icon size={14} />}
                </div>
                <span
                  className={`text-sm ${
                    done ? "text-text" : "text-overlay0"
                  }`}
                >
                  {item.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Next Steps */}
      <div className="rounded-xl border border-surface0 bg-mantle p-4 text-left">
        <span className="text-xs font-semibold text-overlay0 uppercase tracking-wider">
          Getting Started
        </span>
        <div className="mt-3 space-y-2">
          <div className="flex items-start gap-3">
            <div className="w-5 h-5 rounded bg-surface0 flex items-center justify-center shrink-0 mt-0.5">
              <MessageSquare size={12} className="text-mauve" />
            </div>
            <div>
              <p className="text-sm text-text">Start chatting</p>
              <p className="text-xs text-overlay0">
                Run <code className="bg-surface0 px-1 rounded text-xs">nomos chat</code> to start a conversation
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-5 h-5 rounded bg-surface0 flex items-center justify-center shrink-0 mt-0.5">
              <Settings size={12} className="text-mauve" />
            </div>
            <div>
              <p className="text-sm text-text">Connect channels</p>
              <p className="text-xs text-overlay0">
                Add Slack, Discord, or Telegram from the integrations page
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <Link
          href="/integrations"
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-surface1 text-sm font-medium text-subtext0 hover:text-text hover:border-surface2 transition-colors"
        >
          <Settings size={16} />
          Settings
        </Link>
        <Link
          href="/dashboard"
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-mauve text-crust text-sm font-medium hover:bg-mauve/90 transition-colors"
        >
          Go to Dashboard
          <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  );
}
