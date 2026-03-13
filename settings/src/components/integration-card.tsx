import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { StatusBadge } from "./status-badge";

interface IntegrationCardProps {
  title: string;
  description: string;
  icon: LucideIcon;
  href: string;
  status: "connected" | "not_configured" | "error";
  statusLabel?: string;
  details?: string[];
}

export function IntegrationCard({
  title,
  description,
  icon: Icon,
  href,
  status,
  statusLabel,
  details,
}: IntegrationCardProps) {
  return (
    <Link
      href={href}
      className="flex flex-col rounded-xl border border-surface0 bg-mantle p-5 hover:border-surface1 transition-colors group"
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-surface0 flex items-center justify-center text-mauve group-hover:bg-surface1 transition-colors shrink-0">
            <Icon size={20} />
          </div>
          <h3 className="font-semibold text-text">{title}</h3>
        </div>
        <StatusBadge status={status} label={statusLabel} />
      </div>
      <p className="text-xs text-overlay0 mb-3 ml-[52px]">{description}</p>
      {details && details.length > 0 && (
        <div className="mt-3 pt-3 border-t border-surface0">
          {details.map((detail, i) => (
            <p key={i} className="text-xs text-subtext0">
              {detail}
            </p>
          ))}
        </div>
      )}
      <div className="mt-auto pt-3 text-xs text-mauve opacity-0 group-hover:opacity-100 transition-opacity">
        {status === "connected" ? "Manage →" : "Configure →"}
      </div>
    </Link>
  );
}
