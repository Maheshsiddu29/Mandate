import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

export const metadata: Metadata = createMetadata({
  title: "Mandate for developers",
  description:
    "Integrate external agents through @mandate/sdk. Agents propose. Mandate authorizes. Markets settle.",
  path: "/developers",
});

export default function DevelopersPage(): ReactNode {
  return (
    <main id="main-content" className="route-main mandate-docs">
      <div className="page-container">
        <header className="mandate-docs__intro">
          <p className="mandate-kicker">For developers</p>
          <h1>Integrate Mandate.</h1>
          <p>
            Agents propose. Mandate authorizes. Markets settle. External agents
            integrate the same authorization boundary through{" "}
            <code>@mandate/sdk</code> — a thin facade over compile, review, V3
            authorization preparation, screening, reservation, and execution
            preparation.
          </p>
        </header>
        <article className="mandate-docs__content">
          <section>
            <h2>Start here</h2>
            <ul>
              <li>
                <Link href="/docs/sdk">SDK / Developer Integration</Link> —
                actual <code>createMandateClient</code> API and side-effect
                boundary.
              </li>
              <li>
                <Link href="/docs/concepts">Authority Model</Link> — principal,
                agent-local, and portfolio-global authority.
              </li>
              <li>
                <Link href="/docs/proof">Proof & Evidence</Link> — LIVE_MODEL vs
                LIVE_TESTNET and the current V3 testnet settlement.
              </li>
            </ul>
          </section>
          <section>
            <h2>What the SDK does not do</h2>
            <ul>
              <li>Hold the principal private key</li>
              <li>Duplicate verifier / control / ledger logic</li>
              <li>Silently broadcast transactions</li>
              <li>Bake in demo asset assumptions as defaults</li>
            </ul>
          </section>
          <p>
            <Link className="button button--primary focus-ring" href="/docs/sdk">
              Open SDK docs
            </Link>
          </p>
        </article>
      </div>
    </main>
  );
}
