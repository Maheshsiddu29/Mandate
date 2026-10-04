import { DocsCallout } from "@/components/docs/docs-callout";
import { DocsFlow } from "@/components/docs/docs-flow";
import { DocsSection, DocsShell } from "@/components/docs/docs-shell";
import { LIVE_V3_EVIDENCE } from "@/lib/docs/evidence";
import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Autonomous Execution — Mandate Docs",
  description:
    "One signature. Bounded autonomous execution. Settlement allowance, Mandate authorization, and V3 delegated settlement are distinct.",
  path: "/docs/execution",
});

const TOC = [
  { id: "one-signature", label: "One signature" },
  { id: "lifecycle", label: "V3 lifecycle" },
  { id: "allowance-vs-auth", label: "Allowance vs authorization" },
  { id: "signers", label: "Signer separation" },
  { id: "receipt", label: "Receipt and reconciliation" },
] as const;

const LIFECYCLE = [
  "Principal connects wallet",
  "Bounded ERC-20 settlement allowance if required",
  "Principal signs reusable bounded Mandate authorization",
  "Agent proposes action",
  "Mandate verifies proposal + portfolio state",
  "Reservation consumes available authority",
  "Execution delegate approves exact execution",
  "Gate verifies execution",
  "Transaction settles",
  "Receipt is reconciled",
] as const;

export default function ExecutionPage(): ReactNode {
  return (
    <DocsShell
      href="/docs/execution"
      toc={TOC}
      lead="One signature. Bounded autonomous execution."
    >
      <DocsSection id="one-signature" title="One signature. Bounded autonomous execution.">
        <p>
          Under V3, the principal signs a reusable{" "}
          <code>DelegatedPortfolioAuthorizationV3</code> once. That signature
          binds portfolio authority and a bounded Stock testnet execution
          delegation. Ordinary in-policy settlements do not require a new
          per-trade wallet approval.
        </p>
        <p>
          “I didn&apos;t approve that trade. I approved the rules. Mandate
          approved the trade because it satisfied those rules.”
        </p>
      </DocsSection>

      <DocsSection id="lifecycle" title="V3 lifecycle">
        <DocsFlow steps={LIFECYCLE} ariaLabel="V3 autonomous execution lifecycle" />
      </DocsSection>

      <DocsSection id="allowance-vs-auth" title="Settlement allowance vs Mandate authorization">
        <div className="docs-table-wrap">
          <table className="docs-table">
            <thead>
              <tr>
                <th>Surface</th>
                <th>What it does</th>
                <th>What it is not</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>ERC-20 settlement allowance</td>
                <td>Token plumbing so the Gate can pull bounded fixture MDUSD</td>
                <td>Economic Mandate authorization</td>
              </tr>
              <tr>
                <td>Mandate signature</td>
                <td>Signed economic rules + bounded V3 delegation</td>
                <td>An unlimited ERC-20 approval</td>
              </tr>
              <tr>
                <td>Per-trade wallet approval</td>
                <td>None on a successful V3 autonomous trade</td>
                <td>Required for every in-policy Stock settlement under V3</td>
              </tr>
            </tbody>
          </table>
        </div>
        <DocsCallout tone="note">
          <p>
            Renew the bounded settlement allowance when remaining allowance is
            insufficient. Do not describe ERC-20 approval as always one-time or
            forever.
          </p>
        </DocsCallout>
        <DocsCallout tone="limitation">
          <p>
            Current Stock LIVE_TESTNET settlement uses valueless fixture assets
            ({LIVE_V3_EVIDENCE.fixturePair}). Authorized Stock capital and fixture
            debit are different numbers.
          </p>
        </DocsCallout>
      </DocsSection>

      <DocsSection id="signers" title="Principal / agent / execution delegate">
        <ul>
          <li>
            <strong>Principal</strong> — human wallet. Signs the bounded Mandate
            authorization once for the session.
          </li>
          <li>
            <strong>Agent</strong> — proposes and signs the exact candidate /
            execution authorization. Proves who proposed.
          </li>
          <li>
            <strong>Execution delegate</strong> — ephemeral Mandate key. Signs
            the exact execution only after deterministic verification and
            reservation. Distinct from the agent key.
          </li>
        </ul>
        <DocsCallout tone="security">
          <p>
            A compromised agent remains a subset of the principal&apos;s
            authority. The agent cannot become the execution delegate.
          </p>
        </DocsCallout>
      </DocsSection>

      <DocsSection id="receipt" title="Receipt and reconciliation">
        <p>
          After settlement, the receipt records transaction identity, capacity
          consumed, remaining capacity for that authorization, and the evidence
          class. Reconciliation is evidence-only: it never invents a resend.
        </p>
        <p>
          See the current LIVE_TESTNET V3 values on{" "}
          <Link href="/docs/proof">Proof & Evidence</Link>.
        </p>
      </DocsSection>
    </DocsShell>
  );
}
