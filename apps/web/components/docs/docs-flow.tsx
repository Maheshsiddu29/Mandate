import type { ReactNode } from "react";

export function DocsFlow({
  steps,
  ariaLabel,
}: {
  readonly steps: readonly string[];
  readonly ariaLabel: string;
}): ReactNode {
  return (
    <ol className="docs-flow" aria-label={ariaLabel}>
      {steps.map((step, index) => (
        <li key={step} className="docs-flow__item">
          <span className="docs-flow__index">{String(index + 1).padStart(2, "0")}</span>
          <span className="docs-flow__label">{step}</span>
          {index < steps.length - 1 ? (
            <span className="docs-flow__arrow" aria-hidden="true">
              ↓
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
