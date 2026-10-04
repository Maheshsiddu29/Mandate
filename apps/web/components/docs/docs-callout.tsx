import type { ReactNode } from "react";

export type DocsCalloutTone = "note" | "security" | "evidence" | "limitation";

const LABELS: Record<DocsCalloutTone, string> = {
  note: "NOTE",
  security: "SECURITY",
  evidence: "EVIDENCE",
  limitation: "LIMITATION",
};

export function DocsCallout({
  tone,
  children,
}: {
  readonly tone: DocsCalloutTone;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <aside className={`docs-callout docs-callout--${tone}`} role="note">
      <p className="docs-callout__label">{LABELS[tone]}</p>
      <div className="docs-callout__body">{children}</div>
    </aside>
  );
}
