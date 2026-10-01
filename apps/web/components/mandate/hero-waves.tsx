"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

/**
 * The Mandate surface: React Bits Pattern Waves on the Silk preset, tuned to
 * the indigo accent and the near-black page. Loaded on the client only, so
 * the WebGL bundle never blocks first render or the static export. The
 * component pauses offscreen and does not move under prefers-reduced-motion.
 */
const PatternWaves = dynamic(() => import("@/components/react-bits/pattern-waves"), { ssr: false });

export const MANDATE_WAVES = {
  preset: "silk",
  pattern: "dot",
  wave: "silk",
  color: "#6366F1",
  backgroundColor: "#120F17",
  spacing: 9,
  markSize: 0.95,
  depth: 0.95,
  light: 0,
  shine: 0.8,
  contrast: 1.2,
  speed: 0.35,
  scale: 1,
  direction: 20,
  fade: "edges",
  fadeSize: 0.5,
  opacity: 1,
  interactive: true,
  cursorSize: 50,
  cursorStrength: 0.6,
  intro: true,
} as const;

export function HeroWaves({ className = "", paused = false, opacity = MANDATE_WAVES.opacity }: { readonly className?: string; readonly paused?: boolean; readonly opacity?: number }): ReactNode {
  return (
    <div className={`hero-waves ${className}`.trim()} aria-hidden="true">
      <PatternWaves {...MANDATE_WAVES} opacity={opacity} interactive={!paused && MANDATE_WAVES.interactive} paused={paused} />
    </div>
  );
}
