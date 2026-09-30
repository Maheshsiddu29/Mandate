import { AuthorizationField } from "@/components/mandate/authorization-field";
import { MotionDiv } from "@/lib/motion";
import Link from "next/link";
import type { ReactNode } from "react";

export function MandateHero(): ReactNode {
  return (
    <section className="mandate-hero" id="product" aria-labelledby="mandate-title">
      <AuthorizationField className="mandate-hero__field" />
      <div className="mandate-hero__shade" aria-hidden="true" />
      <div className="mandate-hero__content page-container">
        <MotionDiv>
          <p className="mandate-badge">Built for agent-native markets</p>
          <h1 id="mandate-title">
            One authority layer
            <span>for autonomous markets.</span>
          </h1>
          <p className="mandate-hero__support">
            Give specialized agents room to find, negotiate and execute
            opportunities across markets — without giving them unlimited
            control of your assets.
          </p>
          <p className="mandate-hero__principle">
            Agents propose. Mandate authorizes. Markets settle.
          </p>
          <div className="hero-actions">
            <Link className="button button--primary focus-ring" href="/demo">
              Launch Demo
            </Link>
            <Link className="button button--secondary focus-ring" href="/#how-mandate">
              How Mandate Works
            </Link>
          </div>
        </MotionDiv>
      </div>
    </section>
  );
}
