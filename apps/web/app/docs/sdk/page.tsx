import { DocsCallout } from "@/components/docs/docs-callout";
import { DocsCode } from "@/components/docs/docs-code";
import { DocsSection, DocsShell } from "@/components/docs/docs-shell";
import {
  SDK_CLIENT_METHODS,
  SDK_PUBLIC_EXPORTS,
  SDK_QUICKSTART,
} from "@/lib/docs/sdk-example";
import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "SDK / Developer Integration — Mandate Docs",
  description:
    "Integrate external agents through @mandate/sdk. Facade over compile, review, V3 authorization preparation, screen, reserve, prepareExecution, and reconcile.",
  path: "/docs/sdk",
});

const TOC = [
  { id: "story", label: "Developer story" },
  { id: "quickstart", label: "Quickstart" },
  { id: "surface", label: "Public surface" },
  { id: "boundaries", label: "Boundaries" },
  { id: "lifecycle", label: "Authority lifecycle" },
] as const;

export default function SdkPage(): ReactNode {
  return (
    <DocsShell
      href="/docs/sdk"
      toc={TOC}
      lead="Mandate isn't limited to the bundled demo agents. External agents can integrate the same authorization boundary through @mandate/sdk."
    >
      <DocsSection id="story" title="Developer story">
        <p>
          <code>@mandate/sdk</code> is a thin developer facade above existing
          Mandate packages. It exposes compile, review, V3 delegated
          authorization preparation, proposal screening, reservation, execution
          preparation, and reconciliation through existing APIs.
        </p>
        <p>
          It does not own wallet private keys, duplicate verifier logic,
          silently broadcast, or bake in demo asset assumptions.
        </p>
        <DocsCallout tone="security">
          <p>
            A valid agent signature proves who proposed an action. It does not
            prove the action is authorized.
          </p>
        </DocsCallout>
      </DocsSection>

      <DocsSection id="quickstart" title="Quickstart">
        <DocsCode code={SDK_QUICKSTART} language="ts" label="@mandate/sdk" />
      </DocsSection>

      <DocsSection id="surface" title="Public surface">
        <h3>Package exports</h3>
        <ul>
          {SDK_PUBLIC_EXPORTS.map((name) => (
            <li key={name}><code>{name}</code></li>
          ))}
        </ul>
        <h3>MandateClient methods</h3>
        <ul>
          {SDK_CLIENT_METHODS.map((name) => (
            <li key={name}><code>{name}</code></li>
          ))}
        </ul>
        <p>
          Screening returns a discriminated result:{" "}
          <code>authorized: true</code> with <code>kind: &quot;AUTHORIZED&quot;</code>{" "}
          or <code>authorized: false</code> with <code>kind: &quot;REFUSED&quot;</code>{" "}
          and stable reason codes. Do not reduce refusals to a bare boolean.
        </p>
      </DocsSection>

      <DocsSection id="boundaries" title="Side-effect boundary">
        <p>These methods must not broadcast:</p>
        <ul>
          <li><code>compile</code></li>
          <li><code>review</code></li>
          <li><code>screen</code></li>
          <li><code>reserve</code></li>
          <li><code>prepareDelegatedAuthorization</code></li>
          <li><code>prepareExecution</code></li>
        </ul>
        <p>
          <code>prepareExecution</code> requires an injected{" "}
          <code>SettlementBackend</code> (for example{" "}
          <code>createV3SettlementBackend</code>) and uses prepare/dry-run
          paths. There is no public <code>broadcast</code> / <code>send</code>{" "}
          method on the SDK client. <code>reconcile</code> is evidence-only and
          must not resend.
        </p>
        <DocsCallout tone="limitation">
          <p>
            Current Stock settlement proof uses valueless MDUSD/MDEMO fixture
            assets on Robinhood Chain Testnet. The SDK does not imply production
            stock trading.
          </p>
        </DocsCallout>
      </DocsSection>

      <DocsSection id="lifecycle" title="Authority lifecycle">
        <DocsCode
          language="text"
          label="lifecycle"
          code={`compile → review → prepareDelegatedAuthorization → (wallet signs)
  → acceptAuthorization → attachAuthority
  → screen → reserve → prepareExecution → reconcile`}
        />
        <div className="docs-table-wrap">
          <table className="docs-table">
            <thead>
              <tr>
                <th>Step</th>
                <th>Authority effect</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>compile</code></td>
                <td>None — draft only</td>
              </tr>
              <tr>
                <td><code>review</code></td>
                <td>None — fail-closed gate (<code>signable</code>)</td>
              </tr>
              <tr>
                <td><code>prepareDelegatedAuthorization</code></td>
                <td>None — typed data for the wallet</td>
              </tr>
              <tr>
                <td><code>acceptAuthorization</code></td>
                <td>Activates mandate version when signature verifies</td>
              </tr>
              <tr>
                <td><code>screen</code></td>
                <td>Deterministic authorization decision</td>
              </tr>
              <tr>
                <td><code>reserve</code></td>
                <td>Ledger reservation through control</td>
              </tr>
              <tr>
                <td><code>prepareExecution</code></td>
                <td>Exact execution material; broadcasts = 0</td>
              </tr>
              <tr>
                <td><code>reconcile</code></td>
                <td>Evidence-only; never resends</td>
              </tr>
            </tbody>
          </table>
        </div>
      </DocsSection>
    </DocsShell>
  );
}
