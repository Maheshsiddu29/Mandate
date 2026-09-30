import { IntegrationRoster } from "@/components/mandate/agent-preview";
import type { ReactNode } from "react";

export function Infrastructure(): ReactNode {
  return (
    <section className="mandate-section page-container" id="marketplace" aria-labelledby="marketplace-title">
      <div className="mandate-section__heading mandate-section__heading--wide">
        <p className="mandate-kicker">Infrastructure</p>
        <h2 id="marketplace-title">Name the connection. Do not upgrade a fixture.</h2>
        <p>
          Robinhood Chain carries historical live testnet evidence, labelled LIVE_TESTNET.
          Swap, NFT, and yield in the judge demo are fixtures. They are not live markets.
          A fixture label never inherits the historical testnet label.
        </p>
      </div>
      <IntegrationRoster />
    </section>
  );
}
