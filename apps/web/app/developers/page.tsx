import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

export const metadata: Metadata = createMetadata({
  title: "Mandate for developers",
  description:
    "A placeholder for the Mandate integration surface. The judge demo is a static transcript. The SDK is not part of this milestone.",
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
            Agents propose. Mandate authorizes. Markets settle. An integration
            will let an agent submit a signed proposal and read a refusal or a
            child authorization back. This page does not ship that SDK.
          </p>
        </header>
        <article className="mandate-docs__content">
          <section>
            <h2>What exists now</h2>
            <p>
              Judge mode at <Link href="/demo">/demo</Link> plays a committed
              transcript. The browser does not run the protocol, hold a key, or
              call a network. The transcript is generated before the site is built.
            </p>
          </section>
          <section>
            <h2>What a later SDK has to expose</h2>
            <ul>
              <li>A typed proposal a domain agent can sign, without the agent choosing canonical asset identity.</li>
              <li>Screening refusals as reason codes, separate from resource conflicts the Mandate Room can negotiate.</li>
              <li>The Room result as untrusted input, and the verifier result as the only authorization.</li>
              <li>Reservation, evidence class, and Receipt V2 digest for each accepted child.</li>
              <li>A static or local verifier path so a demo never needs a secret.</li>
            </ul>
          </section>
          <p>
            <Link className="button button--primary focus-ring" href="/demo">
              Launch Demo
            </Link>
          </p>
        </article>
      </div>
    </main>
  );
}
