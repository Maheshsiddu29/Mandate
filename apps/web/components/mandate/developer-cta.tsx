import Link from "next/link";
import type { ReactNode } from "react";

export function DeveloperCta(): ReactNode {
  return (
    <section className="mandate-section page-container" aria-labelledby="developer-title">
      <div className="developer-cta">
        <p className="mandate-kicker">Developers</p>
        <h2 id="developer-title">
          Build agents.
          <span>Let Mandate handle authority.</span>
        </h2>
        <div className="hero-actions">
          <Link className="button button--primary focus-ring" href="/docs">
            Read Docs
          </Link>
          <Link className="button button--secondary focus-ring" href="/demo">
            Launch Demo
          </Link>
        </div>
      </div>
    </section>
  );
}
