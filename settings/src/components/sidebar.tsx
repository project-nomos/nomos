"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Settings,
  LayoutGrid,
  MessageSquare,
  MessageCircle,
  Send,
  Mail,
  Phone,
  Database,
  Brain,
  DollarSign,
  Activity,
  Puzzle,
} from "lucide-react";
import { DaemonStatus } from "@/components/daemon-status";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/settings", label: "Assistant", icon: Settings },
];

const channelItems = [
  { href: "/integrations", label: "Overview", icon: LayoutGrid },
  { href: "/integrations/slack", label: "Slack", icon: MessageSquare },
  { href: "/integrations/discord", label: "Discord", icon: MessageCircle },
  { href: "/integrations/telegram", label: "Telegram", icon: Send },
  { href: "/integrations/google", label: "Google", icon: Mail },
  { href: "/integrations/whatsapp", label: "WhatsApp", icon: Phone },
];

const advancedItems = [
  { href: "/admin/database", label: "Database", icon: Database },
  { href: "/admin/memory", label: "Memory", icon: Brain },
  { href: "/admin/extensions", label: "Extensions", icon: Puzzle },
  { href: "/admin/costs", label: "Costs", icon: DollarSign },
  { href: "/admin/context", label: "Context", icon: Activity },
];

export function Sidebar() {
  const pathname = usePathname();

  const renderLink = (item: {
    href: string;
    label: string;
    icon: React.ComponentType<{ size: number }>;
  }) => {
    const isActive =
      pathname === item.href ||
      (item.href !== "/integrations" &&
        item.href !== "/settings" &&
        item.href !== "/dashboard" &&
        pathname.startsWith(item.href));
    return (
      <Link
        key={item.href}
        href={item.href}
        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
          isActive
            ? "bg-surface0 text-mauve font-medium"
            : "text-subtext0 hover:bg-surface0 hover:text-text"
        }`}
      >
        <item.icon size={16} />
        {item.label}
      </Link>
    );
  };

  return (
    <aside className="w-56 shrink-0 border-r border-surface0 bg-mantle h-full overflow-y-auto p-4 flex flex-col">
      <div className="mb-6 px-3 flex items-center gap-3">
        <Image src="/nomos-logo.svg" alt="Nomos" width={32} height={32} className="rounded-lg" />
        <div>
          <h2 className="text-mauve font-bold text-lg tracking-tight leading-tight">Nomos</h2>
          <p className="text-overlay0 text-xs">Settings</p>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5">{navItems.map(renderLink)}</nav>

      <div className="mt-4 mb-2 px-3">
        <span className="text-xs font-semibold text-overlay0 uppercase tracking-wider">
          Channels
        </span>
      </div>

      <nav className="flex flex-col gap-0.5">{channelItems.map(renderLink)}</nav>

      <div className="mt-4 mb-2 px-3">
        <span className="text-xs font-semibold text-overlay0 uppercase tracking-wider">
          Advanced
        </span>
      </div>

      <nav className="flex flex-col gap-0.5">{advancedItems.map(renderLink)}</nav>

      <div className="mt-auto pt-4 border-t border-surface0">
        <DaemonStatus />
      </div>
    </aside>
  );
}
