import { DocsCallout } from "@/components/docs/docs-callout";
import { DocsSection, DocsShell } from "@/components/docs/docs-shell";
import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Authority Model — Mandate Docs",
  description:
    "Principal authority, agent-local authority, portfolio-global authority, Mandate Room, and fail-closed unsupported semantics.",
  path: "/docs/concepts",
});

const TOC = [
  { id: "principal", label: "Principal authority" },
  { id: "agent-local", label: "Agent-local authority" },
  { id: "portfolio-global", label: "Portfolio-global authority" },
  { id: "budget-vs-ceiling", label: "Requested budget vs ceiling" },
  { id: "room", label: "Mandate Room" },
  { id: "canonical-assets", label: "Canonical asset identity" },
  { id: "unsupported", label: "Unsupported semantics" },
] as const;

export default function ConceptsPage(): ReactNode {
  return (
    <DocsShell
      href="/docs/concepts"
      toc={TOC}
      lead="Agent permissions are local. Portfolio authority is global."
    >
      <DocsSection id="principal" title="1. Principal authority">
        <p>
          The principal is the human or organization that owns economic risk.
          The principal signs a Mandate: the machine-readable boundary of
          capital, venues, issuers, representations, recipients, and time.
        </p>
        <p>
          That signature authorizes rules. It does not authorize every later
          action an agent might invent inside those rules. Each exact action is
          still verified.
        </p>
        <DocsCallout tone="security">
          <p>
            A valid signature identifies the proposer. It does not expand
            authority.
          </p>
        </DocsCallout>
      </DocsSection>

      <DocsSection id="agent-local" title="2. Agent-local authority">
        <p>
          Each agent may receive a local budget and domain scope — for example
          Stock up to a signed maximum, Yield up to another, Swap up to another.
          Local authority never grants:
        </p>
        <ul>
          <li>more capital than the signed maximum</li>
          <li>new venues, issuers, or representations</li>
          <li>different recipients</li>
          <li>reuse of a consumed execution</li>
          <li>authority after expiry or revocation</li>
        </ul>
        <p>
          Agent authentication proves who proposed. It never proves the action
          is authorized.
        </p>
      </DocsSection>

      <DocsSection id="portfolio-global" title="3. Portfolio-global authority">
        <p className="docs-lead-line">
          Agent permissions are local. Portfolio authority is global.
        </p>
        <p>
          Portfolio-global limits — total capital, derivative exposure, illiquid
          exposure, chain/venue allowlists — bind every agent together. An
          action that fits one agent&apos;s local budget can still be refused if
          it would break a portfolio-global invariant.
        </p>
      </DocsSection>

      <DocsSection id="budget-vs-ceiling" title="4. Requested budget vs authority ceiling">
        <p>
          A requested allocation is what the principal asks for in natural
          language or a form. A signed authority ceiling is what the Mandate
          actually commits.
        </p>
        <p>
          These are not the same. Mandate does not silently clip a request to
          make signing easier. If the request conflicts with preset ceilings or
          asks for unsupported semantics, signing stays blocked until the
          conflict is resolved.
        </p>
        <DocsCallout tone="note">
          <p>
            <strong>Mandate does not make the numbers fit by changing authority.</strong>
          </p>
        </DocsCallout>
      </DocsSection>

      <DocsSection id="room" title="5. Mandate Room">
        <p>
          Mandate Room is the negotiation surface over remaining economic room:
        </p>
        <p>
          principal authority − consumed − reserved − unavailable by policy =
          remaining Room.
        </p>
        <p>
          Agents may propose and negotiate inside that remaining Room. The Room
          result is untrusted input. Deterministic verification and reservation
          remain the only authority path.
        </p>
      </DocsSection>

      <DocsSection id="canonical-assets" title="6. Canonical asset identity">
        <p>
          A ticker is not a canonical asset identity, and a canonical asset is
          not a representation.
        </p>
        <ul>
          <li>
            <strong>Ticker</strong> — display label (for example NVDA). Ambiguous alone.
          </li>
          <li>
            <strong>Canonical asset</strong> — the underlying identity Mandate
            authorizes (scheme + value, such as a FIGI).
          </li>
          <li>
            <strong>Representation</strong> — a specific tokenized form of that
            underlying on a chain/venue.
          </li>
        </ul>
        <p>
          Two instruments can share a ticker and still be different economic
          objects. Unapproved representations are refused. Mandate does not
          authorize “whatever looks cheapest under the same ticker.”
        </p>
      </DocsSection>

      <DocsSection id="unsupported" title="7. Unsupported semantics / unresolved choices">
        <p>
          Natural-language instructions can express constraints the current
          Mandate schema cannot faithfully represent. Those constraints are not
          silently rewritten into weaker fields.
        </p>
        <p>
          Example — Scenario C style request:
        </p>
        <ul>
          <li>$5,000 total</li>
          <li>Stock $2,000 · Yield $1,000 · Swap remainder</li>
          <li>no Perps</li>
          <li>no trade above $500</li>
          <li>approved venues only</li>
        </ul>
        <p>
          If current preset authority ceilings independently remain Stock $800,
          Yield $800, Swap $500, the requested budgets are <strong>not</strong>{" "}
          silently clipped to those ceilings. The unsupported per-trade
          restriction is <strong>not</strong> converted into aggregate authority.
          Signing remains blocked until conflicts and unsupported semantics are
          resolved or explicitly acknowledged where the issue policy allows.
        </p>
        <DocsCallout tone="limitation">
          <p>
            Per-trade natural-language limits are currently{" "}
            <strong>UNSUPPORTED</strong> as signed Mandate fields. They are not
            reinterpreted as portfolio maxima.
          </p>
        </DocsCallout>
      </DocsSection>
    </DocsShell>
  );
}
