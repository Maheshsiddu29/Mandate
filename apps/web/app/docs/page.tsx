import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Mandate Docs — Authority for agent-native markets",
  description:
    "How Mandate separates authentication from authorization, how a portfolio mandate constrains agents, and which market connections are live.",
  path: "/docs",
});

const SECTIONS = [
  ["overview", "Overview"],
  ["authority", "Authority"],
  ["pipeline", "Pipeline"],
  ["assets", "Canonical assets"],
  ["markets", "Markets"],
  ["demo", "Demo boundary"],
  ["build", "Build"],
  ["limits", "Limits"],
] as const;

export default function DocsPage(): ReactNode {
  return (
    <main id="main-content" className="route-main mandate-docs">
      <div className="page-container">
        <header className="mandate-docs__intro">
          <p className="mandate-kicker">Documentation</p>
          <h1>One authority layer for many agents.</h1>
          <p>
            Mandate is the authorization and execution layer for agent-native
            financial markets. Agents propose. Mandate authorizes. Markets settle.
            This page describes the model the site demonstrates. It does not
            describe a deployed production protocol.
          </p>
        </header>

        <div className="mandate-docs__layout">
          <nav className="mandate-docs__nav" aria-label="Documentation sections">
            {SECTIONS.map(([id, label], index) => (
              <a key={id} href={`#${id}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {label}
              </a>
            ))}
          </nav>

          <article className="mandate-docs__content">
            <section id="overview">
              <h2>Overview</h2>
              <p>
                A principal sets a portfolio mandate: a budget and the issuers,
                venues, representations, and sizes that are allowed. Specialized
                agents may search and negotiate inside that mandate. They do not
                receive open-ended control of the assets.
              </p>
            </section>

            <section id="authority">
              <h2>Authentication is not authorization</h2>
              <p>
                Authentication answers “this really is the agent.” Authorization
                answers “the agent may perform this exact action.” A genuine
                agent can still request a fake same-ticker representation, an
                unknown venue, an unknown issuer, or a size the portfolio does
                not allow. Mandate blocks that request.
              </p>
            </section>

            <section id="pipeline">
              <h2>Pipeline</h2>
              <p>
                Discovery, reasoning, and negotiation stay offchain: principal,
                portfolio mandate, agents, mandate room, and portfolio
                verification. Authorized settlement is onchain: child
                authorization, execution gate, markets, and receipt.
              </p>
              <ol>
                <li>Principal defines the mandate.</li>
                <li>Agents propose.</li>
                <li>Mandate room negotiates.</li>
                <li>Portfolio verification accepts, blocks, or releases.</li>
                <li>A child authorization is the only permission to settle.</li>
                <li>The receipt records what happened.</li>
              </ol>
            </section>

            <section id="assets">
              <h2>A ticker is not an asset identity</h2>
              <p>
                Two instruments can share a display ticker and still be
                different assets. Mandate does not pick the cheaper quote.
                The unapproved representation is blocked. The eligible asset
                is the one with a verified canonical underlying, a verified
                representation, an approved issuer, and an approved chain.
              </p>
            </section>

            <section id="markets">
              <h2>Markets</h2>
              <p>Integration labels on the site mean only what they say.</p>
              <ul>
                <li>Robinhood Chain — live testnet. Not a production venue.</li>
                <li>Lighter — domain integration for perps exposure.</li>
                <li>Arbitrum — settlement integration. Not a live fill.</li>
                <li>NFT Market — fixture.</li>
                <li>Yield — fixture.</li>
              </ul>
              <p>Fixtures are scripted demonstrations. They are not live markets.</p>
            </section>

            <section id="demo">
              <h2>Demo boundary</h2>
              <p>
                The public demo is a scripted review of one $2,000 portfolio
                mandate. It does not connect a wallet, submit an order, or
                claim a live execution. The receipt id is a demo identifier.
              </p>
            </section>

            <section id="build">
              <h2>Build</h2>
              <p>
                Build agents that propose. Let Mandate handle authority. The
                pages on this site read mock contracts in <code>lib/mandate/contracts.ts</code>.
                A later backend can replace that module. The page components
                should keep the same portfolio, agent, and receipt shape.
              </p>
            </section>

            <section id="limits">
              <h2>Limits</h2>
              <ul>
                <li>Mandate does not make two issuers economically identical.</li>
                <li>Mandate does not choose routes by price.</li>
                <li>Mandate does not give an agent a standing right to move the whole portfolio.</li>
                <li>This website is not evidence of a production deployment.</li>
              </ul>
            </section>
          </article>
        </div>
      </div>
    </main>
  );
}
