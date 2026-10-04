"use client";

import { DOCS_NAV } from "@/lib/docs/nav";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

function pathActive(pathname: string, href: string): boolean {
  if (href === "/docs") return pathname === "/docs";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DocsSidebar(): ReactNode {
  const pathname = usePathname();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) toggleRef.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    panelRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const links = (
    <ul className="docs-sidebar__list">
      {DOCS_NAV.map((item) => {
        const active = pathActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              className="docs-sidebar__link focus-ring"
              aria-current={active ? "page" : undefined}
              data-active={active ? "true" : undefined}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      <div className="docs-sidebar__mobile-bar">
        <button
          ref={toggleRef}
          type="button"
          className="docs-sidebar__menu-toggle focus-ring"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Close docs menu" : "Docs menu"}
        </button>
        <span className="docs-sidebar__current">
          {DOCS_NAV.find((item) => pathActive(pathname, item.href))?.label ?? "Docs"}
        </span>
      </div>

      {open ? (
        <button
          type="button"
          className="docs-sidebar__scrim"
          aria-label="Close docs menu"
          onClick={() => setOpen(false)}
        />
      ) : null}

      <nav
        ref={panelRef}
        id={panelId}
        className="docs-sidebar"
        aria-label="Documentation"
        data-open={open ? "true" : undefined}
      >
        <p className="docs-sidebar__kicker">Documentation</p>
        {links}
      </nav>
    </>
  );
}
