import { docsNeighbors, type DocsHref } from "@/lib/docs/nav";
import Link from "next/link";
import type { ReactNode } from "react";

export function DocsPrevNext({ href }: { readonly href: DocsHref }): ReactNode {
  const { prev, next } = docsNeighbors(href);
  return (
    <nav className="docs-pager" aria-label="Documentation page navigation">
      {prev ? (
        <Link className="docs-pager__link docs-pager__link--prev focus-ring" href={prev.href}>
          <span>Previous</span>
          <strong>{prev.label}</strong>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link className="docs-pager__link docs-pager__link--next focus-ring" href={next.href}>
          <span>Next</span>
          <strong>{next.label}</strong>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
