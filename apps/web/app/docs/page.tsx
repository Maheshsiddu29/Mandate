import { DocsFlow } from "@/components/docs/docs-flow";
import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Mandate Docs — Authorization for autonomous agents",
  description:
    "Build agents that can act without giving them unlimited authority. Mandate is the authorization and execution control plane for autonomous financial agents.",
  path: "/docs",
});

const FLOW = [
  "Principal",
  "Signed Mandate",
  "Agents",
  "Mandate Control",
  "Reservation",
  "Execution Gate",
  "Market",
  "Receipt",
] as const;

export default function DocsHomePage(): ReactNode {
  return (
    <div className="docs-home">
      <header className="docs-home__hero">
        <p className="docs-article__eyebrow">ONE AUTHORITY LAYER · MANY AGENTS · MULTIPLE MARKETS</p>
        <h1>Build agents that can act without giving them unlimited authority.</h1>
        <p>
          Mandate provides a shared authorization boundary for autonomous
          financial agents. Define portfolio authority once, let agents reason
          independently, and verify each economic action before execution.
        </p>
        <div className="docs-home__actions">
          <Link className="button button--primary focus-ring" href="/docs/concepts">
            Get started
          </Link>
          <Link className="button button--secondary focus-ring" href="/docs/proof">
            View live proof
          </Link>
          <Link className="button button--secondary focus-ring" href="/docs/sdk">
            SDK
          </Link>
        </div>
      </header>

      <section className="docs-card-grid" aria-label="Documentation paths">
        <Link className="docs-card focus-ring" href="/docs/concepts">
          <p className="docs-card__kicker">Understand the model</p>
          <strong>Authority Model</strong>
          <p>How principal authority becomes bounded agent authority.</p>
        </Link>
        <Link className="docs-card focus-ring" href="/docs/sdk">
          <p className="docs-card__kicker">Integrate an agent</p>
          <strong>SDK</strong>
          <p>Screen external agent proposals through Mandate.</p>
        </Link>
        <Link className="docs-card focus-ring" href="/docs/proof">
          <p className="docs-card__kicker">Inspect the proof</p>
          <strong>Proof & Evidence</strong>
          <p>See what is model-generated, offchain, simulated, and live on testnet.</p>
        </Link>
      </section>

      <section className="docs-home__flow" aria-labelledby="docs-flow-title">
        <h2 id="docs-flow-title">Authority path</h2>
        <p className="docs-lead-line">
          Agents propose. Mandate authorizes. Markets settle.
        </p>
        <DocsFlow steps={FLOW} ariaLabel="Mandate authority path" />
      </section>

      <section className="docs-section" id="overview" style={{ borderTop: "1px solid var(--mandate-border)" }}>
        <h2>What Mandate is</h2>
        <p>
          Mandate is the authorization and execution control plane for
          autonomous financial agents. Humans define economic authority once.
          Agents reason and act inside it. Mandate verifies whether each
          resulting action is permitted.
        </p>
        <p>
          A wallet or agent signature answers <strong>who proposed this</strong>.
          Mandate answers <strong>whether this exact economic action is allowed</strong>.
          Authentication is not authorization.
        </p>
        <p>
          Mandate is not an investment adviser, trading strategy, wallet
          replacement, brokerage, token issuer, or universal router. It is
          infrastructure that keeps agent action inside signed economic rules.
        </p>
        <p>
          Continue with the{" "}
          <Link href="/docs/concepts">Authority Model</Link>,{" "}
          <Link href="/docs/execution">Autonomous Execution</Link>, or the{" "}
          <Link href="/docs/sdk">SDK</Link>.
        </p>
      </section>
    </div>
  );
}
