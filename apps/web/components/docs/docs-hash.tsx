"use client";

import { copyText } from "@/components/docs/copy-text";
import { useState, type ReactNode } from "react";

type CopyState = "idle" | "copying" | "copied" | "failed";

function abbreviate(value: string): string {
  if (!/^0x[0-9a-fA-F]{16,}$/.test(value)) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

export function DocsHash({
  value,
  href,
  label,
}: {
  readonly value: string;
  readonly href?: string | null;
  readonly label?: string;
}): ReactNode {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const short = abbreviate(value);

  async function copy(): Promise<void> {
    setCopyState("copying");
    const copied = await copyText(value);
    setCopyState(copied ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 2000);
  }

  const copyLabel = copyState === "copying" ? `Copying ${label ?? "value"}` : copyState === "copied" ? `Copied ${label ?? "value"}` : copyState === "failed" ? `Copy failed for ${label ?? "value"}` : `Copy ${label ?? "value"}`;

  return (
    <span className="docs-hash">
      {label ? <span className="docs-hash__label">{label}</span> : null}
      {href ? (
        <a
          className="docs-hash__value focus-ring"
          href={href}
          target="_blank"
          rel="noreferrer"
          title={value}
        >
          <code>{short}</code>
        </a>
      ) : (
        <code className="docs-hash__value" title={value}>
          {short}
        </code>
      )}
      <button
        type="button"
        className="docs-hash__copy focus-ring"
        aria-label={copyLabel}
        title={value}
        onClick={() => {
          void copy();
        }}
      >
        <span aria-live="polite">{copyState === "idle" ? "Copy" : copyState === "copying" ? "Copying…" : copyState === "copied" ? "Copied" : "Copy failed"}</span>
      </button>
    </span>
  );
}
