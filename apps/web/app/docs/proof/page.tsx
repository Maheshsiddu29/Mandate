import { DocsCallout } from "@/components/docs/docs-callout";
import { DocsHash } from "@/components/docs/docs-hash";
import { DocsSection, DocsShell } from "@/components/docs/docs-shell";
import { EVIDENCE_CLASSES, LIVE_V3_EVIDENCE } from "@/lib/docs/evidence";
import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Proof & Evidence — Mandate Docs",
  description:
    "Evidence classes, proof stack, and the current LIVE_TESTNET V3 settlement on Robinhood Chain Testnet.",
  path: "/docs/proof",
});

const TOC = [
  { id: "classes", label: "Evidence classes" },
  { id: "stack", label: "Proof stack" },
  { id: "live-v3", label: "Live V3 proof" },
  { id: "fixture", label: "Fixture disclosure" },
] as const;

export default function ProofPage(): ReactNode {
  const e = LIVE_V3_EVIDENCE;

  return (
    <DocsShell
      href="/docs/proof"
      toc={TOC}
      lead="Evidence classes are not interchangeable. LIVE_MODEL is not LIVE_TESTNET."
    >
      <DocsSection id="classes" title="Evidence classes">
        <DocsCallout tone="evidence">
          <p>
            LIVE_MODEL means a model produced the result. It does not imply a
            blockchain transaction.
          </p>
        </DocsCallout>
        <div className="docs-table-wrap">
          <table className="docs-table">
            <thead>
              <tr>
                <th>Class</th>
                <th>Meaning</th>
              </tr>
            </thead>
            <tbody>
              {EVIDENCE_CLASSES.map((item) => (
                <tr key={item.id}>
                  <td><code>{item.id}</code></td>
                  <td>{item.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Authorization evidence is not settlement evidence. A reserved /
          authorized outcome can be OFFCHAIN_ONLY while Stock settlement for the
          same session is LIVE_TESTNET.
        </p>
      </DocsSection>

      <DocsSection id="stack" title="Proof stack">
        <div className="docs-stack">
          <div className="docs-stack__layer docs-stack__layer--claimed">
            <span>Layer 1</span>
            <strong>Agent reasoning</strong>
            <p>LIVE_MODEL / OFFCHAIN — advisory proposals inside closed schemas.</p>
          </div>
          <div className="docs-stack__layer docs-stack__layer--claimed">
            <span>Layer 2</span>
            <strong>Authorization</strong>
            <p>Deterministic Mandate verification and reservation.</p>
          </div>
          <div className="docs-stack__layer docs-stack__layer--claimed">
            <span>Layer 3</span>
            <strong>Local real-EVM execution</strong>
            <p>
              Multiple executions under one principal authorization; replay,
              refusal, cap, and revocation tests against real Gate bytecode.
            </p>
          </div>
          <div className="docs-stack__layer docs-stack__layer--claimed">
            <span>Layer 4</span>
            <strong>Robinhood Chain Testnet</strong>
            <p>LIVE_TESTNET settlement evidence on chain id {e.chainId}.</p>
          </div>
          <div className="docs-stack__layer docs-stack__layer--unclaimed">
            <span>Layer 5</span>
            <strong>Production / mainnet</strong>
            <p>NOT CLAIMED.</p>
          </div>
        </div>
      </DocsSection>

      <DocsSection id="live-v3" title="Live V3 proof">
        <DocsCallout tone="evidence">
          <p>
            Evidence: <code>{e.label}</code> · {e.chain} · chain id {e.chainId}
          </p>
        </DocsCallout>
        <DocsCallout tone="limitation">
          <p id="FIXTURE_QUALIFICATION">{e.qualification}</p>
        </DocsCallout>
        <dl className="docs-proof-grid">
          <div className="docs-proof-row">
            <dt>Chain</dt>
            <dd>{e.chain} ({e.chainId})</dd>
          </div>
          <div className="docs-proof-row">
            <dt>V3 Gate</dt>
            <dd><DocsHash value={e.gate} label="Gate" /></dd>
          </div>
          <div className="docs-proof-row">
            <dt>Principal</dt>
            <dd><DocsHash value={e.principal} label="Principal" /></dd>
          </div>
          <div className="docs-proof-row">
            <dt>Execution delegate</dt>
            <dd><DocsHash value={e.executionDelegate} label="Delegate" /></dd>
          </div>
          <div className="docs-proof-row">
            <dt>Transaction</dt>
            <dd>
              <DocsHash
                value={e.transaction}
                href={e.explorerTx()}
                label="Transaction"
              />
            </dd>
          </div>
          <div className="docs-proof-row">
            <dt>Block</dt>
            <dd>{e.block}</dd>
          </div>
          <div className="docs-proof-row">
            <dt>Gas used</dt>
            <dd>{e.gasUsed}</dd>
          </div>
          <div className="docs-proof-row">
            <dt>Execution nonce</dt>
            <dd>{e.executionNonce}</dd>
          </div>
          <div className="docs-proof-row">
            <dt>Delegation digest</dt>
            <dd><DocsHash value={e.delegationDigest} label="Delegation digest" /></dd>
          </div>
          <div className="docs-proof-row">
            <dt>Reservation</dt>
            <dd><DocsHash value={e.reservation} label="Reservation" /></dd>
          </div>
          <div className="docs-proof-row">
            <dt>Receipt digest</dt>
            <dd><DocsHash value={e.receiptDigest} label="Receipt digest" /></dd>
          </div>
          <div className="docs-proof-row">
            <dt>Consumed capacity</dt>
            <dd>{e.consumedCapacity}</dd>
          </div>
          <div className="docs-proof-row">
            <dt>Remaining capacity</dt>
            <dd>{e.remainingCapacity} — {e.remainingCapacityNote}</dd>
          </div>
          <div className="docs-proof-row">
            <dt>Session</dt>
            <dd><code>{e.sessionId}</code></dd>
          </div>
          <div className="docs-proof-row">
            <dt>Evidence</dt>
            <dd><code>{e.label}</code></dd>
          </div>
        </dl>
        <p>
          Gate address matches the committed manifest{" "}
          <code>{e.manifestPath}</code>.
        </p>
      </DocsSection>

      <DocsSection id="fixture" title="Fixture disclosure">
        <p className="docs-lead-line">{e.qualification}</p>
        <ul>
          <li>Fixture pair: <strong>{e.fixturePair}</strong></li>
          <li>Canonical demo execution: <strong>{e.fixtureIn} → {e.fixtureOut}</strong></li>
          <li>Authorized Stock capital: <strong>{e.authorizedStockCapital}</strong></li>
          <li>Actual fixture debit/output: <strong>{e.fixtureIn} / {e.fixtureOut}</strong></li>
        </ul>
        <DocsCallout tone="limitation">
          <p>
            Do not read authorized capital as fixture debit, and do not read
            MDEMO output as a purchased equity position or a production stock
            token. Fixture settlement is not a production stock trade.
          </p>
        </DocsCallout>
      </DocsSection>
    </DocsShell>
  );
}
