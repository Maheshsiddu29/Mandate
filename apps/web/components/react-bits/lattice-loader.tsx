"use client";

/**
 * Adapted from React Bits Lattice Loader (TS + CSS), commit
 * e1bbb696fc53f7f91e694c529e4d68c899773b6e.
 * https://www.reactbits.dev/micro/lattice-loader
 *
 * Mandate keeps the official pattern/status model and removes the internal
 * stopwatch. Callers provide authoritative elapsed telemetry instead.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import "./lattice-loader.css";

export type LatticeStatus = "working" | "done" | "error";
export type LatticePatternName = "orbit" | "ripple" | "snake" | "sweep";

interface Pattern {
  readonly cells: readonly (number | null)[];
  readonly loop: number;
  readonly scale: number;
  readonly lit?: number;
}

export interface LatticeLoaderProps {
  readonly label: string;
  readonly status?: LatticeStatus;
  readonly pattern?: LatticePatternName;
  readonly elapsedMs?: number | null;
  readonly showTimer?: boolean;
  readonly className?: string;
}

const PATTERNS: Record<LatticePatternName, Pattern> = {
  orbit: { cells: [0, 1, 2, 7, null, 3, 6, 5, 4], loop: 8, scale: 1.2 },
  ripple: { cells: [2, 1, 2, 1, 0, 1, 2, 1, 2], loop: 4.8, scale: 1.5 },
  snake: { cells: [0, 1, 2, 5, 4, 3, 6, 7, 8], loop: 9, scale: 1, lit: 0.35 },
  sweep: { cells: [0, 1, 2, 1, 2, 3, 2, 3, 4], loop: 5, scale: 1, lit: 0.45 },
};

const MARKS: Record<"done" | "error", readonly number[]> = {
  done: [2, 3, 5, 7],
  error: [0, 2, 4, 6, 8],
};

function formatElapsed(value: number): string {
  if (value >= 60_000) return `${Math.floor(value / 60_000)}m ${((value % 60_000) / 1_000).toFixed(1)}s`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

export function LatticeLoader({
  label,
  status = "working",
  pattern = "orbit",
  elapsedMs = null,
  showTimer = true,
  className = "",
}: LatticeLoaderProps): ReactNode {
  const resolved = PATTERNS[pattern];
  const step = 90 * resolved.scale;
  const cycle = Math.round(resolved.loop * step);
  const lastMark = useRef<"done" | "error">("done");
  if (status !== "working") lastMark.current = status;
  const mark = status === "working" ? lastMark.current : status;
  const [announcement, setAnnouncement] = useState(`${label}, in progress`);

  useEffect(() => {
    if (status === "working") setAnnouncement(`${label}, in progress`);
    else setAnnouncement(`${status === "done" ? "Done" : "Failed"}${elapsedMs === null ? "" : ` after ${formatElapsed(elapsedMs)}`}`);
  }, [elapsedMs, label, status]);

  return (
    <span
      role="status"
      className={`lattice-loader${className === "" ? "" : ` ${className}`}`}
      data-status={status}
      style={{ "--ll-cycle": `${cycle}ms` } as CSSProperties}
    >
      <span className="lattice-loader__grid" aria-hidden="true">
        <span className="lattice-loader__layer lattice-loader__run">
          {resolved.cells.map((unit, index) => (
            <span
              key={index}
              className="lattice-loader__cell"
              data-hole={unit === null ? "" : undefined}
              data-lit={resolved.lit === undefined ? undefined : Math.round(resolved.lit * 100)}
              style={unit === null ? undefined : { animationDelay: `${Math.round(unit * step)}ms` }}
            />
          ))}
        </span>
        <span className="lattice-loader__layer lattice-loader__mark">
          {resolved.cells.map((_, index) => (
            <span key={index} className="lattice-loader__cell" data-on={MARKS[mark].includes(index) ? "" : undefined} />
          ))}
        </span>
      </span>
      <span className="lattice-loader__label" aria-hidden="true">{label}</span>
      {showTimer && elapsedMs !== null ? <span className="lattice-loader__timer" aria-hidden="true">{formatElapsed(elapsedMs)}</span> : null}
      <span className="lattice-loader__sr">{announcement}</span>
    </span>
  );
}
