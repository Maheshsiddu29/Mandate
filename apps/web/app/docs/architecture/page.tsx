import { DocsCallout } from "@/components/docs/docs-callout";
import { DocsSection, DocsShell } from "@/components/docs/docs-shell";
import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Architecture — Mandate Docs",
  description:
    "Authorization pipeline, package dependency direction, and the advisory boundary for model reasoning.",
  path: "/docs/architecture",
});

const TOC = [
  { id: "pipeline", label: "Authorization pipeline" },
  { id: "packages", label: "Package architecture" },
  { id: "models", label: "Model / Jev boundary" },
] as const;

const PIPELINE = [
  "Natural-language intent",
  "Compiler",
  "Structured Mandate",
  "Authority Review",
  "Principal Authorization",
  "Portfolio Ledger",
  "Agents / Proposals",
  "Control + Mandate Room",
  "Reservation",
  "Execution Preparation",
  "V3 Execution Gate",
  "Market",
  "Receipt + Reconciliation",
] as const;

const PACKAGES = [
  { name: "@mandate/kernel", detail: "Canonical encodings, verifier primitives" },
  { name: "@mandate/core", detail: "Core identifiers, quantities, authority terms" },
  { name: "@mandate/ledger", detail: "Authority graph and principal ledger" },
  { name: "@mandate/control", detail: "Invariant / reservation engine" },
  { name: "@mandate/portfolio", detail: "Portfolio mandate layer above control" },
  { name: "@mandate/live-agents", detail: "Live AI Lab / compile / review / session" },
  { name: "settlement adapters", detail: "Injected testnet prepare / reconcile backends" },
  { name: "@mandate/sdk", detail: "Thin facade above the layers above" },
] as const;

export default function ArchitecturePage(): ReactNode {
  return (
    <DocsShell
      href="/docs/architecture"
      toc={TOC}
      lead="Mandate separates proposal, authorization, reservation, and settlement into explicit layers with one dependency direction."
    >
      <DocsSection id="pipeline" title="Authorization pipeline">
        <div className="docs-arch" aria-label="Mandate authorization pipeline">
          {PIPELINE.map((node, index) => (
            <div key={node} className="docs-arch__row">
              <div className="docs-arch__node">{node}</div>
              {index < PIPELINE.length - 1 ? (
                <div className="docs-arch__edge" aria-hidden="true">
                  ↓
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </DocsSection>

      <DocsSection id="packages" title="Package / dependency architecture">
        <p>
          Runtime dependency direction (higher packages depend downward; never
          the reverse):
        </p>
        <div className="docs-packages" aria-label="Package dependency stack">
          {[...PACKAGES].reverse().map((entry, index, arr) => (
            <div key={entry.name} className="docs-packages__item">
              <span className="docs-packages__rank">
                {String(arr.length - index).padStart(2, "0")}
              </span>
              <span className="docs-packages__name">
                <code>{entry.name}</code> — {entry.detail}
              </span>
            </div>
          ))}
        </div>
        <p>
          Exact edges include <code>control → ledger → core → kernel</code>,{" "}
          <code>portfolio → control</code>, and{" "}
          <code>live-agents → portfolio</code>. Settlement prepare/reconcile
          backends are injected above the Live AI Lab session surface. The SDK
          facade sits above those integration layers and must not be imported by
          lower packages.
        </p>
        <DocsCallout tone="note">
          <p>
            The SDK sits above existing functionality. It is a facade, not a
            second authority implementation.
          </p>
        </DocsCallout>
      </DocsSection>

      <DocsSection id="models" title="Where model reasoning sits">
        <p>
          Model output — including Jev and Live AI Lab providers — is advisory
          or ranking only. It is never final authority.
        </p>
        <ul>
          <li>Models do not supply contract addresses, chain IDs, or constraint values as authority.</li>
          <li>Models do not add candidates outside a closed admissible set.</li>
          <li>Models do not relax Mandate constraints.</li>
          <li>The permitted-execution set must be identical whether a model is present, absent, failed, or adversarial.</li>
        </ul>
        <DocsCallout tone="security">
          <p>
            Economic authority lives in deterministic verification. Advisory
            ranking cannot authorize capital movement.
          </p>
        </DocsCallout>
      </DocsSection>
    </DocsShell>
  );
}
