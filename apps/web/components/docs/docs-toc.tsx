"use client";

import { useEffect, useState, type ReactNode } from "react";

export type DocsTocItem = {
  readonly id: string;
  readonly label: string;
};

export function DocsToc({
  items,
}: {
  readonly items: readonly DocsTocItem[];
}): ReactNode {
  const [active, setActive] = useState(items[0]?.id ?? "");

  useEffect(() => {
    if (items.length === 0) return;
    const elements = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null);

    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        const top = visible[0]?.target;
        if (top && typeof top.id === "string" && top.id.length > 0) {
          setActive(top.id);
        }
      },
      {
        rootMargin: "-20% 0px -60% 0px",
        threshold: [0, 0.25, 0.5, 1],
      },
    );

    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;

  return (
    <nav className="docs-toc" aria-label="On this page">
      <p className="docs-toc__title">On this page</p>
      <ol>
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className="focus-ring"
              aria-current={active === item.id ? "location" : undefined}
              data-active={active === item.id ? "true" : undefined}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
