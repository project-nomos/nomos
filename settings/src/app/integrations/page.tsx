"use client";

import { useEffect, useState } from "react";
import { MessageSquare, Globe, MessageCircle, Send, Phone, Smartphone } from "lucide-react";
import { IntegrationCard } from "@/components/integration-card";
import type { IntegrationStatus } from "@/lib/types";

export default function IntegrationsPage() {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-mauve border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const slack = status?.slack;
  const google = status?.google;
  const discord = status?.discord;
  const telegram = status?.telegram;
  const whatsapp = status?.whatsapp;
  const imessage = status?.imessage;

  return (
    <div>
      <h1 className="text-2xl font-bold text-text mb-1">Integrations</h1>
      <p className="text-sm text-overlay0 mb-8">Connect and manage your services</p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-4 max-w-4xl">
        <IntegrationCard
          title="Slack"
          description="Workspaces and user mode"
          icon={MessageSquare}
          href="/integrations/slack"
          status={slack?.configured ? "connected" : "not_configured"}
          statusLabel={
            slack?.configured
              ? `${slack.workspaces.length} workspace${slack.workspaces.length !== 1 ? "s" : ""}`
              : undefined
          }
          details={slack?.workspaces.map((w) => w.teamName)}
        />

        <IntegrationCard
          title="Discord"
          description="Bot integration"
          icon={MessageCircle}
          href="/integrations/discord"
          status={discord?.configured ? "connected" : "not_configured"}
        />

        <IntegrationCard
          title="Telegram"
          description="Bot integration"
          icon={Send}
          href="/integrations/telegram"
          status={telegram?.configured ? "connected" : "not_configured"}
        />

        <IntegrationCard
          title="Google Workspace"
          description="Gmail, Calendar, Drive, and more via gws CLI"
          icon={Globe}
          href="/integrations/google"
          status={google?.configured ? "connected" : "not_configured"}
          statusLabel={
            google?.configured
              ? `${google.accountCount} account${google.accountCount !== 1 ? "s" : ""}`
              : undefined
          }
          details={google?.configured ? [`Services: ${google.services}`] : undefined}
        />

        <IntegrationCard
          title="WhatsApp"
          description="QR code authentication via Baileys"
          icon={Phone}
          href="/integrations/whatsapp"
          status={whatsapp?.configured ? "connected" : "not_configured"}
          statusLabel={whatsapp?.configured ? "Enabled" : undefined}
        />

        <IntegrationCard
          title="Messages.app"
          description="Local chat.db or BlueBubbles server"
          icon={Smartphone}
          href="/integrations/imessage"
          status={imessage?.configured ? "connected" : "not_configured"}
          statusLabel={imessage?.configured ? "Enabled" : undefined}
        />
      </div>
    </div>
  );
}
