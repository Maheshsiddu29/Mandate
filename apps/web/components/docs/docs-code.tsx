"use client";

import { useId, useState, type ReactNode } from "react";

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
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

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
          aria-label={copied ? "Copied" : "Copy code"}
          onClick={() => {
            void copy();
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre id={id} className="docs-code__pre" tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
