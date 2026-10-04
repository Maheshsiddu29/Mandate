import { DocsCallout } from "@/components/docs/docs-callout";
import { DocsSection, DocsShell } from "@/components/docs/docs-shell";
import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Security Model — Mandate Docs",
  description:
    "VALID AGENT ≠ VALID ACTION. Threat model, policy stress refusals, replay, reservations, signer separation, and fail-closed mandatory data.",
  path: "/docs/security",
});

const TOC = [
  { id: "principle", label: "Core principle" },
  { id: "threat-model", label: "Threat model" },
  { id: "firewall", label: "Policy stress evidence" },
  { id: "controls", label: "Control mechanisms" },
] as const;

export default function SecurityPage(): ReactNode {
  return (
    <DocsShell
      href="/docs/security"
      toc={TOC}
      lead="VALID AGENT ≠ VALID ACTION"
    >
      <DocsSection id="principle" title="Core principle">
        <p className="docs-lead-line">VALID AGENT ≠ VALID ACTION</p>
        <p>
          A valid agent is not automatically authorized to perform a valid
          action. Mandate assumes agents can misunderstand, hallucinate, be
          prompt-injected, become compromised, select stale markets, exceed
          limits, reuse old proposals, or redirect proceeds.
        </p>
        <DocsCallout tone="security">
          <p>
            A compromised agent remains a subset of the principal&apos;s
            authority.
          </p>
        </DocsCallout>
      </DocsSection>

      <DocsSection id="threat-model" title="Threat model">
        <p>Mandate is designed around adversarial or defective agents that can:</p>
        <ul>
          <li>misunderstand instructions</li>
          <li>hallucinate venues, assets, or sizes</li>
          <li>be prompt-injected</li>
          <li>become compromised</li>
          <li>select stale or wrong markets</li>
          <li>exceed local or portfolio limits</li>
          <li>reuse old proposals or executions</li>
          <li>redirect proceeds to unapproved recipients</li>
        </ul>
        <p>
          Agent wallets alone are insufficient because they only answer
          identity. They do not answer economic permission for the exact action.
        </p>
      </DocsSection>

      <DocsSection id="firewall" title="Policy stress / firewall evidence">
        <DocsCallout tone="evidence">
          <p>
            <strong>OFFCHAIN AUTHORIZATION TEST</strong>
            <br />
            NOT LIVE_TESTNET SETTLEMENT
          </p>
        </DocsCallout>
        <p>
          Same valid Swap agent identity. Different proposals. Deterministic
          Mandate verification:
        </p>
        <div className="docs-table-wrap">
          <table className="docs-table">
            <thead>
              <tr>
                <th>Attempt</th>
                <th>Result</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Recipient mismatch</td>
                <td>REFUSED</td>
                <td><code>RECIPIENT_NOT_ALLOWED</code></td>
              </tr>
              <tr>
                <td>Unapproved venue</td>
                <td>REFUSED</td>
                <td><code>VENUE_NOT_ALLOWED</code></td>
              </tr>
              <tr>
                <td>Representation mismatch</td>
                <td>REFUSED</td>
                <td><code>INSTRUMENT_UNKNOWN</code> / representation failure</td>
              </tr>
              <tr>
                <td>Over limit</td>
                <td>REFUSED</td>
                <td><code>AGENT_LIMIT_EXCEEDED</code> / <code>ALLOCATION_INSUFFICIENT</code></td>
              </tr>
              <tr>
                <td>Compliant control</td>
                <td>AUTHORIZED</td>
                <td>Exact action inside signed scope</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>For refused attempts:</p>
        <ul>
          <li>Transaction: None</li>
          <li>Broadcasts: 0</li>
          <li>Ledger unchanged: Yes</li>
        </ul>
      </DocsSection>

      <DocsSection id="controls" title="Control mechanisms">
        <h3>Replay / nonces</h3>
        <p>
          V3 executions are keyed by <code>(delegationDigest, executionNonce)</code>.
          A consumed nonce cannot authorize another settlement.
        </p>
        <h3>Reservations</h3>
        <p>
          Authority is reserved before execution preparation. A reservation
          consumes available Room so concurrent agents cannot oversubscribe the
          same capital.
        </p>
        <h3>Signer separation</h3>
        <p>
          Principal, agent, and execution delegate are distinct roles. Compromise
          of the agent does not yield the delegate key.
        </p>
        <h3>Expiry and revocation</h3>
        <p>
          The passage of time never restores an authorization. Expiry and
          principal revocation end delegated capacity. Restored sessions are
          evidence-only when the ephemeral delegate key is gone.
        </p>
        <h3>Crash / reconciliation</h3>
        <p>
          Durable journals and reconciliation reconstruct settlement state
          without resending. Evidence-only restore must not broadcast.
        </p>
        <h3>Fail-closed mandatory data</h3>
        <p>
          Missing authority, unresolved review blockers, unknown instruments,
          and unsupported mandatory semantics refuse. There is no “proceed
          anyway” path that invents authority.
        </p>
      </DocsSection>
    </DocsShell>
  );
}
