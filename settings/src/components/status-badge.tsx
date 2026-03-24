interface StatusBadgeProps {
  status: "connected" | "not_configured" | "error";
  label?: string;
}

const styles: Record<StatusBadgeProps["status"], string> = {
  connected: "bg-green/15 text-green border-green/30",
  not_configured: "bg-surface1/50 text-overlay1 border-surface2/30",
  error: "bg-red/15 text-red border-red/30",
};

const defaultLabels: Record<StatusBadgeProps["status"], string> = {
  connected: "Connected",
  not_configured: "Not configured",
  error: "Error",
};

export function StatusBadge({ status, label }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${styles[status]}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          status === "connected" ? "bg-green" : status === "error" ? "bg-red" : "bg-overlay0"
        }`}
      />
      {label ?? defaultLabels[status]}
    </span>
  );
}
