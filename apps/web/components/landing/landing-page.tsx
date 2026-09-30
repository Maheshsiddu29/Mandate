import { AgentPreview } from "@/components/mandate/agent-preview";
import { AuthorityPipeline } from "@/components/mandate/authority-pipeline";
import { CanonicalAssets } from "@/components/mandate/canonical-assets";
import { DeveloperCta } from "@/components/mandate/developer-cta";
import { MandateHero } from "@/components/mandate/hero";
import { Infrastructure } from "@/components/mandate/infrastructure";
import { WhyMandate } from "@/components/mandate/why-mandate";
import type { ReactNode } from "react";

export function LandingPage(): ReactNode {
  return (
    <main id="main-content" className="landing-main mandate-page">
      <MandateHero />

      <section className="mandate-section page-container" id="agents" aria-labelledby="agents-title">
        <div className="mandate-section__heading">
          <h2 id="agents-title">
            One principal.
            <span>Five agents.</span>
            <span>One authority layer.</span>
          </h2>
        </div>
        <AgentPreview />
      </section>

      <WhyMandate />
      <CanonicalAssets />
      <AuthorityPipeline />
      <Infrastructure />
      <DeveloperCta />
    </main>
  );
}
