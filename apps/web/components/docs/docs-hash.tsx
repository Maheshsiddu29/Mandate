"use client";

import { useState, type ReactNode } from "react";

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
  const [copied, setCopied] = useState(false);
  const short = abbreviate(value);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

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
        aria-label={copied ? `Copied ${label ?? "value"}` : `Copy ${label ?? "value"}`}
        title={value}
        onClick={() => {
          void copy();
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
