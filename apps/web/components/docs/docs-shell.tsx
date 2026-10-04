import { DocsPrevNext } from "@/components/docs/docs-prev-next";
import { DocsToc, type DocsTocItem } from "@/components/docs/docs-toc";
import { docsItem, type DocsHref } from "@/lib/docs/nav";
import type { ReactNode } from "react";

export function DocsShell({
  href,
  toc = [],
  children,
  eyebrow,
  lead,
}: {
  readonly href: DocsHref;
  readonly toc?: readonly DocsTocItem[];
  readonly children: ReactNode;
  readonly eyebrow?: string;
  readonly lead?: string;
}): ReactNode {
  const item = docsItem(href);

  return (
    <div className="docs-shell__main">
      <article className="docs-article">
        <header className="docs-article__header">
          <p className="docs-article__eyebrow">{eyebrow ?? "Mandate Docs"}</p>
          <h1>{item.title}</h1>
          <p className="docs-article__lead">{lead ?? item.description}</p>
        </header>
        <div className="docs-article__body">{children}</div>
        <DocsPrevNext href={href} />
      </article>
      {toc.length > 0 ? (
        <aside className="docs-shell__toc">
          <DocsToc items={toc} />
        </aside>
      ) : null}
    </div>
  );
}

export function DocsSection({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section id={id} className="docs-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
