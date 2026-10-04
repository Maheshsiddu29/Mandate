import { DocsCallout } from "@/components/docs/docs-callout";
import { DocsHash } from "@/components/docs/docs-hash";
import { DocsSection, DocsShell } from "@/components/docs/docs-shell";
import { EVIDENCE_CLASSES, LIVE_V3_EVIDENCE } from "@/lib/docs/evidence";
import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Reference & Limitations — Mandate Docs",
  description:
    "Robinhood Chain Testnet facts, evidence classifications, current limitations, and glossary.",
  path: "/docs/reference",
});

const TOC = [
  { id: "chain", label: "Chain & Gate" },
  { id: "evidence", label: "Evidence classifications" },
  { id: "limits", label: "Current limitations" },
  { id: "glossary", label: "Glossary" },
] as const;

const GLOSSARY = [
  ["Principal", "The party that owns economic risk and signs Mandate authority."],
  ["Mandate", "Machine-readable economic authorization boundary signed by the principal."],
  ["Agent", "A proposer that reasons and signs proposals inside Mandate scope. Authentication ≠ authorization."],
  ["Mandate Room", "Negotiation surface over remaining authority after consumed, reserved, and policy-unavailable capital."],
  ["Reservation", "Atomic claim on available authority before execution preparation."],
  ["Execution delegate", "Ephemeral Mandate signer that approves an exact execution after verification — distinct from the agent."],
  ["Canonical asset", "Underlying asset identity (scheme + value), independent of ticker display."],
  ["Representation", "A specific tokenized form of a canonical asset on a chain/venue."],
  ["Evidence class", "Label for what kind of proof a claim rests on (LIVE_MODEL, LIVE_TESTNET, FIXTURE, SIMULATED, OFFCHAIN_ONLY)."],
  ["Settlement allowance", "Bounded ERC-20 token plumbing so a Gate can pull funding tokens — not Mandate authorization."],
] as const;

export default function ReferencePage(): ReactNode {
  const e = LIVE_V3_EVIDENCE;

  return (
    <DocsShell
      href="/docs/reference"
      toc={TOC}
      lead="Facts, classifications, and honest limits for the current buildathon surface."
    >
      <DocsSection id="chain" title="Robinhood Chain Testnet">
        <dl className="docs-proof-grid">
          <div className="docs-proof-row">
            <dt>Network</dt>
            <dd>{e.chain}</dd>
          </div>
          <div className="docs-proof-row">
            <dt>Chain ID</dt>
            <dd>{e.chainId}</dd>
          </div>
          <div className="docs-proof-row">
            <dt>V3 Gate</dt>
            <dd>
              <DocsHash value={e.gate} label="V3 Gate" />
              <div style={{ marginTop: "0.35rem", color: "var(--mandate-text-tertiary)", fontSize: "0.82rem" }}>
                {e.gateKind} · manifest <code>{e.manifestPath}</code>
              </div>
            </dd>
          </div>
        </dl>
      </DocsSection>

      <DocsSection id="evidence" title="Evidence classifications">
        <ul>
          {EVIDENCE_CLASSES.map((item) => (
            <li key={item.id}>
              <code>{item.id}</code> — {item.meaning}
            </li>
          ))}
        </ul>
        <DocsCallout tone="evidence">
          <p>
            Evidence classes must not be conflated. LIVE_MODEL ≠ LIVE_TESTNET.
            Authorization evidence ≠ settlement evidence.
          </p>
        </DocsCallout>
      </DocsSection>

      <DocsSection id="limits" title="Current limitations">
        <ul>
          <li>Stock LIVE_TESTNET settlement uses valueless fixture assets ({e.fixturePair}).</li>
          <li>Not production brokerage execution.</li>
          <li>No mainnet settlement is claimed.</li>
          <li>Not every agent has a live settlement connector.</li>
          <li>Swap / Yield outcomes may be OFFCHAIN_ONLY.</li>
          <li>Mandatory natural-language semantics that cannot be faithfully represented block signing.</li>
          <li>Per-trade natural-language constraints are currently UNSUPPORTED as signed Mandate fields.</li>
          <li>Evidence classes must not be conflated.</li>
          <li>The SDK does not hide blockchain transaction submission behind innocent methods.</li>
          <li>Current buildathon proof is not a regulatory or compliance claim.</li>
        </ul>
        <DocsCallout tone="limitation">
          <p>
            {e.qualification} Authorized Stock capital ({e.authorizedStockCapital})
            is not the fixture debit ({e.fixtureIn}).
          </p>
        </DocsCallout>
      </DocsSection>

      <DocsSection id="glossary" title="Glossary">
        <dl className="docs-glossary">
          {GLOSSARY.map(([term, meaning]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{meaning}</dd>
            </div>
          ))}
        </dl>
      </DocsSection>
    </DocsShell>
  );
}
