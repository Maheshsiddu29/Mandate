import { HeroWaves } from "@/components/mandate/hero-waves";
import { MotionDiv } from "@/lib/motion";
import Link from "next/link";
import type { ReactNode } from "react";

const PROOF = ["Five agents", "Shared portfolio authority", "Robinhood Chain testnet settlement"] as const;

export function MandateHero(): ReactNode {
  return (
    <section className="mandate-hero" id="product" aria-labelledby="mandate-title">
      <HeroWaves className="mandate-hero__field" />
      <div className="mandate-hero__shade" aria-hidden="true" />
      <div className="mandate-hero__content page-container">
        <MotionDiv>
          <p className="mandate-badge">Mandate</p>
          <h1 id="mandate-title">
            One authority layer
            <span>for autonomous markets.</span>
          </h1>
          <p className="mandate-hero__support">
            Let specialized agents search, negotiate and act. Mandate controls
            what they are actually allowed to execute.
          </p>
          <div className="hero-actions">
            <Link className="button button--primary focus-ring" href="/demo/live">
              Launch Live Demo
            </Link>
            <Link className="button button--secondary focus-ring" href="/demo">
              Protocol Replay
            </Link>
          </div>
          <ul className="mandate-hero__proof" aria-label="What the demo shows">
            {PROOF.map((item) => <li key={item}>{item}</li>)}
          </ul>
          <p className="mandate-hero__principle">
            Agents propose. Agents negotiate. Mandate authorizes. Markets settle.
          </p>
        </MotionDiv>
      </div>
    </section>
  );
}
