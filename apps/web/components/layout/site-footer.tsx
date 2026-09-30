import { BrandLogo } from "@/components/brand/brand-logo";
import Link from "next/link";
import type { ReactNode } from "react";

export function SiteFooter(): ReactNode {
  return (
    <footer className="site-footer">
      <div className="site-footer__waves" aria-hidden="true" />
      <div className="site-footer__inner page-container">
        <div className="site-footer__brand">
          <Link
            href="/"
            className="site-footer__logo focus-ring"
            aria-label="Mandate home"
          >
            <BrandLogo />
          </Link>
          <p>
            The authorization and execution layer for agent-native financial
            markets.
          </p>
        </div>

        <nav className="site-footer__nav" aria-label="Footer navigation">
          <Link className="focus-ring" href="/#product">Product</Link>
          <Link className="focus-ring" href="/#security">Security</Link>
          <Link className="focus-ring" href="/docs">Docs</Link>
          <Link className="focus-ring" href="/demo">Demo</Link>
        </nav>
      </div>
    </footer>
  );
}
