"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { RoleName } from "./live-model";

/** Simple geometric marks, one per domain. No avatars, no faces. */
export function AgentGlyph({ role, size = 20 }: { readonly role: RoleName; readonly size?: number }): ReactNode {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (role) {
    case "stock":
      return <svg {...common}><path d="M7 4v16M17 6v12" /><rect x="5" y="8" width="4" height="7" rx="1" /><rect x="15" y="10" width="4" height="5" rx="1" /></svg>;
    case "swap":
      return <svg {...common}><path d="M5 8h13l-3.5-3.5M19 16H6l3.5 3.5" /></svg>;
    case "nft":
      return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m4 16 4.5-4.5 4 4 2.5-2.5L20 18" /><circle cx="15.5" cy="8.5" r="1.4" /></svg>;
    case "yield":
      return <svg {...common}><path d="M4 9.5 12 5l8 4.5-8 4.5Z" /><path d="m4 14 8 4.5 8-4.5" /></svg>;
    case "perps":
      return <svg {...common}><path d="M4 18h16" /><path d="m5 14 4.5-4 3.5 2.5L19 6" /><path d="M15 6h4v4" /></svg>;
  }
}

/** A small status pill. Uppercase is reserved for these short state words. */
export function Pill({ tone = "neutral", children }: { readonly tone?: "neutral" | "good" | "warn" | "bad" | "accent"; readonly children: ReactNode }): ReactNode {
  return <span className={`mw-pill mw-pill--${tone}`}>{children}</span>;
}

/**
 * A modal side sheet on the native dialog element: focus is trapped and
 * Escape closes it. Full screen on phones.
 */
export function Sheet({ open, onClose, title, kicker, wide = false, children }: { readonly open: boolean; readonly onClose: () => void; readonly title: string; readonly kicker?: string; readonly wide?: boolean; readonly children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const id = `sheet-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={wide ? "mw-sheet mw-sheet--wide" : "mw-sheet"}
      aria-labelledby={id}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="mw-sheet__inner">
        <header className="mw-sheet__head">
          <div>
            {kicker === undefined ? null : <p className="mw-kicker">{kicker}</p>}
            <h2 id={id}>{title}</h2>
          </div>
          <button className="mw-icon-button" type="button" aria-label={`Close ${title}`} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </header>
        <div className="mw-sheet__body">{open ? children : null}</div>
      </div>
    </dialog>
  );
}
