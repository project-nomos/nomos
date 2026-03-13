"use client";

import { useEffect, useState } from "react";
import { Activity, AlertCircle } from "lucide-react";

interface DaemonInfo {
  running: boolean;
  pid?: number;
}

export function DaemonStatus() {
  const [status, setStatus] = useState<DaemonInfo | null>(null);

  useEffect(() => {
    const check = () => {
      fetch("/api/daemon/status")
        .then((r) => r.json())
        .then(setStatus)
        .catch(() => setStatus({ running: false }));
    };

    check();
    const interval = setInterval(check, 15000);
    return () => clearInterval(interval);
  }, []);

  if (!status) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs">
      {status.running ? (
        <>
          <Activity size={12} className="text-green" />
          <span className="text-subtext0">
            Daemon <span className="text-green">running</span>
            {status.pid && <span className="text-overlay0"> (PID {status.pid})</span>}
          </span>
        </>
      ) : (
        <>
          <AlertCircle size={12} className="text-overlay0" />
          <span className="text-overlay0">Daemon stopped</span>
        </>
      )}
    </div>
  );
}
