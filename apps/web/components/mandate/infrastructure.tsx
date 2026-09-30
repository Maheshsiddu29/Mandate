import { marketIntegrations } from "@/lib/mandate/contracts";
import type { ReactNode } from "react";

export function Infrastructure(): ReactNode {
  return (
    <section className="mandate-section page-container" id="marketplace" aria-labelledby="marketplace-title">
      <div className="mandate-section__heading mandate-section__heading--wide">
        <p className="mandate-kicker">Infrastructure</p>
        <h2 id="marketplace-title">Name the connection. Do not upgrade a fixture.</h2>
        <p>
          Robinhood Chain is a live testnet connection. NFT Market and Yield
          are fixtures used to show blocked and released proposals. They are
          not live markets.
        </p>
      </div>

      <div className="integration-grid">
        {marketIntegrations.map((market) => (
          <article key={market.name} className="integration-card" data-live={market.live}>
            <p className="integration-card__status">{market.status}</p>
            <h3>{market.name}</h3>
            <p>{market.summary}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
