"use client";

import { copyText } from "@/components/docs/copy-text";
import { useId, useState, type ReactNode } from "react";

type CopyState = "idle" | "copying" | "copied" | "failed";

export function DocsCode({
  code,
  language = "ts",
  label,
}: {
  readonly code: string;
  readonly language?: string;
  readonly label?: string;
}): ReactNode {
  const id = useId();
  const [copyState, setCopyState] = useState<CopyState>("idle");

  async function copy(): Promise<void> {
    setCopyState("copying");
    const copied = await copyText(code);
    setCopyState(copied ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 2000);
  }

  const copyLabel = copyState === "copying" ? "Copying code" : copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy code";

  return (
    <div className="docs-code">
      <div className="docs-code__bar">
        <span className="docs-code__meta">
          {label ?? language}
        </span>
        <button
          type="button"
          className="docs-code__copy focus-ring"
          aria-controls={id}
          aria-label={copyLabel}
          onClick={() => {
            void copy();
          }}
        >
          <span aria-live="polite">{copyState === "idle" ? "Copy" : copyState === "copying" ? "Copying…" : copyLabel}</span>
        </button>
      </div>
      <pre id={id} className="docs-code__pre" tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
