"use client";

import { useCallback, useEffect, useRef } from "react";

export interface GNode {
  id: string;
  kind: string;
  name: string;
  aliases: string[];
  summary: string | null;
  externalKind: string | null;
  externalRef: string | null;
  confidence: number;
  degree: number;
}

export interface GLink {
  id: string;
  source: string;
  target: string;
  relType: string;
  fact: string | null;
  origin: string;
  weight: number;
  invalid: boolean;
}

/** Catppuccin-Mocha-ish palette keyed by node kind. */
export const KIND_COLORS: Record<string, string> = {
  person: "#89b4fa", // blue
  org: "#f9e2af", // yellow
  project: "#a6e3a1", // green
  topic: "#cba6f7", // mauve
  decision: "#fab387", // peach
  value: "#f38ba8", // red
  event: "#94e2d5", // teal
  wiki: "#74c7ec", // sapphire
  moc: "#f5c2e7", // pink
  chunk: "#9399b2", // overlay
};
export function colorForKind(kind: string): string {
  return KIND_COLORS[kind] ?? "#9399b2";
}

interface Pt {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface GraphCanvasProps {
  nodes: GNode[];
  links: GLink[];
  onNodeClick?: (n: GNode) => void;
  onNodeHover?: (n: GNode | null) => void;
  showSemantic?: boolean;
}

export function GraphCanvas({
  nodes,
  links,
  onNodeClick,
  onNodeHover,
  showSemantic = true,
}: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Mutable simulation + view state (kept in refs so re-renders don't reset it).
  const pos = useRef<Map<string, Pt>>(new Map());
  const view = useRef({ scale: 1, tx: 0, ty: 0 });
  const alpha = useRef(1);
  const hovered = useRef<string | null>(null);
  const dragId = useRef<string | null>(null);
  const panning = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const size = useRef({ w: 800, h: 600 });

  // Latest data, read inside the rAF loop without re-subscribing.
  const data = useRef<{ nodes: GNode[]; links: GLink[]; showSemantic: boolean }>({
    nodes,
    links,
    showSemantic,
  });
  const cbs = useRef({ onNodeClick, onNodeHover });
  cbs.current = { onNodeClick, onNodeHover };

  // Sync incoming data; seed positions for new nodes, drop stale, reheat.
  useEffect(() => {
    const visibleLinks = showSemantic ? links : links.filter((l) => l.origin !== "semantic");
    data.current = { nodes, links: visibleLinks, showSemantic };
    const { w, h } = size.current;
    const seen = new Set<string>();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      seen.add(n.id);
      if (!pos.current.has(n.id)) {
        const ang = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
        const r = 40 + Math.random() * Math.min(w, h) * 0.35;
        pos.current.set(n.id, {
          x: w / 2 + Math.cos(ang) * r,
          y: h / 2 + Math.sin(ang) * r,
          vx: 0,
          vy: 0,
        });
      }
    }
    const stale: string[] = [];
    for (const id of pos.current.keys()) if (!seen.has(id)) stale.push(id);
    for (const id of stale) pos.current.delete(id);
    alpha.current = 1;
  }, [nodes, links, showSemantic]);

  const screenToWorld = useCallback((sx: number, sy: number) => {
    const v = view.current;
    return { x: (sx - v.tx) / v.scale, y: (sy - v.ty) / v.scale };
  }, []);

  const nodeAt = useCallback(
    (sx: number, sy: number): GNode | null => {
      const { x, y } = screenToWorld(sx, sy);
      const ns = data.current.nodes;
      for (let i = ns.length - 1; i >= 0; i--) {
        const n = ns[i]!;
        const p = pos.current.get(n.id);
        if (!p) continue;
        const r = radius(n);
        if ((p.x - x) ** 2 + (p.y - y) ** 2 <= (r + 4) ** 2) return n;
      }
      return null;
    },
    [screenToWorld],
  );

  // Physics + render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      size.current = { w: rect.width, h: rect.height };
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const step = () => {
      const { nodes: ns, links: ls } = data.current;
      const a = alpha.current;
      const { w, h } = size.current;

      // Integrate forces only while "warm" (saves CPU once settled).
      if (a > 0.01 && ns.length > 0) {
        const cx = w / 2;
        const cy = h / 2;
        const REPULSE = 1400;
        const SPRING = 0.02;
        const GRAVITY = 0.015;
        // Repulsion (O(n^2) — fine for personal-brain scale).
        for (let i = 0; i < ns.length; i++) {
          const pi = pos.current.get(ns[i]!.id);
          if (!pi) continue;
          for (let j = i + 1; j < ns.length; j++) {
            const pj = pos.current.get(ns[j]!.id);
            if (!pj) continue;
            let dx = pi.x - pj.x;
            let dy = pi.y - pj.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) {
              dx = Math.random() - 0.5;
              dy = Math.random() - 0.5;
              d2 = 0.01;
            }
            const f = (REPULSE * a) / d2;
            const d = Math.sqrt(d2);
            const fx = (dx / d) * f;
            const fy = (dy / d) * f;
            pi.vx += fx;
            pi.vy += fy;
            pj.vx -= fx;
            pj.vy -= fy;
          }
        }
        // Springs along edges.
        for (const l of ls) {
          const ps = pos.current.get(l.source);
          const pt = pos.current.get(l.target);
          if (!ps || !pt) continue;
          const dx = pt.x - ps.x;
          const dy = pt.y - ps.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const target = 90;
          const f = SPRING * a * (d - target);
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          ps.vx += fx;
          ps.vy += fy;
          pt.vx -= fx;
          pt.vy -= fy;
        }
        // Gravity to center + damping + integrate.
        for (const n of ns) {
          const p = pos.current.get(n.id);
          if (!p || n.id === dragId.current) continue;
          p.vx += (cx - p.x) * GRAVITY * a;
          p.vy += (cy - p.y) * GRAVITY * a;
          p.vx *= 0.82;
          p.vy *= 0.82;
          p.x += p.vx;
          p.y += p.vy;
        }
        alpha.current = a * 0.985;
      }

      render(ctx, dpr);
      raf = requestAnimationFrame(step);
    };

    const render = (c: CanvasRenderingContext2D, ratio: number) => {
      const { nodes: ns, links: ls } = data.current;
      const v = view.current;
      const { w, h } = size.current;
      c.save();
      c.setTransform(ratio, 0, 0, ratio, 0, 0);
      c.clearRect(0, 0, w, h);
      c.translate(v.tx, v.ty);
      c.scale(v.scale, v.scale);

      const hov = hovered.current;
      const neighbors = new Set<string>();
      if (hov) {
        neighbors.add(hov);
        for (const l of ls) {
          if (l.source === hov) neighbors.add(l.target);
          else if (l.target === hov) neighbors.add(l.source);
        }
      }

      // Edges.
      c.lineWidth = 1 / v.scale;
      for (const l of ls) {
        const ps = pos.current.get(l.source);
        const pt = pos.current.get(l.target);
        if (!ps || !pt) continue;
        const dim = hov ? !(neighbors.has(l.source) && neighbors.has(l.target)) : false;
        if (l.invalid) {
          c.setLineDash([4 / v.scale, 4 / v.scale]);
          c.strokeStyle = dim ? "rgba(243,139,168,0.08)" : "rgba(243,139,168,0.5)";
        } else if (l.origin === "semantic") {
          c.setLineDash([2 / v.scale, 3 / v.scale]);
          c.strokeStyle = dim ? "rgba(148,226,213,0.08)" : "rgba(148,226,213,0.45)";
        } else {
          c.setLineDash([]);
          c.strokeStyle = dim ? "rgba(147,153,178,0.08)" : "rgba(147,153,178,0.4)";
        }
        c.beginPath();
        c.moveTo(ps.x, ps.y);
        c.lineTo(pt.x, pt.y);
        c.stroke();
      }
      c.setLineDash([]);

      // Nodes.
      for (const n of ns) {
        const p = pos.current.get(n.id);
        if (!p) continue;
        const r = radius(n);
        const dim = hov ? !neighbors.has(n.id) : false;
        c.beginPath();
        c.arc(p.x, p.y, r, 0, Math.PI * 2);
        c.fillStyle = dim ? withAlpha(colorForKind(n.kind), 0.18) : colorForKind(n.kind);
        c.fill();
        if (n.id === hov) {
          c.lineWidth = 2 / v.scale;
          c.strokeStyle = "#cdd6f4";
          c.stroke();
        }
        // Labels: hovered set, or larger nodes when zoomed in.
        const showLabel = n.id === hov || neighbors.has(n.id) || (v.scale > 1.1 && n.degree >= 2);
        if (showLabel && !dim) {
          c.font = `${12 / v.scale}px ui-sans-serif, system-ui, sans-serif`;
          c.fillStyle = "#cdd6f4";
          c.textAlign = "center";
          c.fillText(
            n.name.length > 24 ? n.name.slice(0, 23) + "…" : n.name,
            p.x,
            p.y - r - 4 / v.scale,
          );
        }
      }
      c.restore();
    };

    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // ── Pointer + wheel interaction ──
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const hit = nodeAt(sx, sy);
      e.currentTarget.setPointerCapture(e.pointerId);
      last.current = { x: sx, y: sy };
      if (hit) {
        dragId.current = hit.id;
        alpha.current = Math.max(alpha.current, 0.3);
      } else {
        panning.current = true;
      }
    },
    [nodeAt],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const v = view.current;
      if (dragId.current) {
        const w = screenToWorld(sx, sy);
        const p = pos.current.get(dragId.current);
        if (p) {
          p.x = w.x;
          p.y = w.y;
          p.vx = 0;
          p.vy = 0;
        }
        alpha.current = Math.max(alpha.current, 0.2);
      } else if (panning.current) {
        v.tx += sx - last.current.x;
        v.ty += sy - last.current.y;
        last.current = { x: sx, y: sy };
      } else {
        const hit = nodeAt(sx, sy);
        const id = hit?.id ?? null;
        if (id !== hovered.current) {
          hovered.current = id;
          cbs.current.onNodeHover?.(hit);
          if (e.currentTarget) e.currentTarget.style.cursor = hit ? "pointer" : "grab";
        }
      }
    },
    [nodeAt, screenToWorld],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const movedLittle = Math.abs(sx - last.current.x) < 4 && Math.abs(sy - last.current.y) < 4;
    if (dragId.current && movedLittle) {
      const n = data.current.nodes.find((x) => x.id === dragId.current);
      if (n) cbs.current.onNodeClick?.(n);
    }
    dragId.current = null;
    panning.current = false;
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const v = view.current;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const next = Math.min(Math.max(v.scale * factor, 0.15), 6);
    // Zoom around the cursor.
    v.tx = sx - (sx - v.tx) * (next / v.scale);
    v.ty = sy - (sy - v.ty) * (next / v.scale);
    v.scale = next;
  }, []);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        className="h-full w-full touch-none"
        style={{ cursor: "grab" }}
      />
    </div>
  );
}

function radius(n: GNode): number {
  return 4 + Math.min(Math.sqrt(n.degree) * 2.2, 14);
}

function withAlpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
