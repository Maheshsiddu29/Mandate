"use client";

import { BrandLogo } from "@/components/brand/brand-logo";
import { useReducedMotion } from "@/lib/motion";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

type NavItem = {
  label: string;
  href: string;
};

const NAV_ITEMS: readonly NavItem[] = [
  { label: "Product", href: "/#product" },
  { label: "Marketplace", href: "/#marketplace" },
  { label: "Developers", href: "/developers" },
  { label: "Security", href: "/#security" },
  { label: "Docs", href: "/docs" },
];

function itemHash(href: string): string {
  const index = href.indexOf("#");
  return index === -1 ? "" : href.slice(index);
}

function isItemActive(pathname: string, hash: string, item: NavItem): boolean {
  const itemAnchor = itemHash(item.href);
  if (item.href === "/developers") return pathname.startsWith("/developers");

  if (item.href.startsWith("/docs")) {
    return pathname === "/docs" || pathname.startsWith("/docs/");
  }

  if (pathname !== "/") {
    return false;
  }

  if (itemAnchor === "#product") {
    return hash === "" || hash === "#product";
  }

  return hash === itemAnchor;
}

function NavigationLinks({
  pathname,
  hash,
  onNavigate,
}: {
  pathname: string;
  hash: string;
  onNavigate: () => void;
}): ReactNode {
  return (
    <>
      {NAV_ITEMS.map((item) => {
        const active = isItemActive(pathname, hash, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className="mobile-nav__link focus-ring"
            onClick={onNavigate}
          >
            {item.label}
          </Link>
        );
      })}
      <Link href="/demo/live" className="mobile-nav__link focus-ring" onClick={onNavigate}>
        Live Demo
      </Link>
    </>
  );
}

export function Nav(): ReactNode {
  const pathname = usePathname();
  const prefersReducedMotion = useReducedMotion();
  const listRef = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hash, setHash] = useState("");
  const [pillRect, setPillRect] = useState<{ x: number; width: number } | null>(
    null
  );
  const [hasMeasured, setHasMeasured] = useState(false);
  const activeIndex = NAV_ITEMS.findIndex((item) =>
    isItemActive(pathname, hash, item)
  );

  useEffect(() => {
    const readHash = (): void => setHash(window.location.hash);
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, [pathname]);

  useLayoutEffect(() => {
    const list = listRef.current;
    const activeElement =
      activeIndex >= 0 ? itemRefs.current[activeIndex] : null;

    if (!list || !activeElement) {
      setPillRect(null);
      return;
    }

    const listRect = list.getBoundingClientRect();
    const itemRect = activeElement.getBoundingClientRect();
    setPillRect({
      x: itemRect.left - listRect.left,
      width: itemRect.width,
    });
  }, [activeIndex, pathname]);

  useEffect(() => {
    if (!pillRect) {
      return;
    }

    const animationFrame = requestAnimationFrame(() => setHasMeasured(true));
    return () => cancelAnimationFrame(animationFrame);
  }, [pillRect]);

  return (
    <header className="site-nav-wrap">
      <nav className="site-nav glass-nav" aria-label="Primary navigation">
        <Link href="/" className="brand-mark focus-ring" aria-label="Mandate home">
          <BrandLogo />
        </Link>

        <ul ref={listRef} className="desktop-nav">
          {pillRect ? (
            <motion.span
              aria-hidden="true"
              initial={false}
              animate={{ x: pillRect.x, width: pillRect.width }}
              transition={
                !hasMeasured || prefersReducedMotion
                  ? { duration: 0 }
                  : { type: "spring", stiffness: 380, damping: 32 }
              }
              className="desktop-nav__pill"
            />
          ) : null}

          {NAV_ITEMS.map((item, index) => {
            const active = isItemActive(pathname, hash, item);
            return (
              <li
                key={item.href}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                className="desktop-nav__item"
              >
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className="desktop-nav__link focus-ring"
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <Link href="/demo/live" className="nav-launch button button--primary focus-ring">
          Live Demo
        </Link>

        <button
          type="button"
          className="menu-toggle focus-ring"
          aria-expanded={menuOpen}
          aria-controls="mobile-navigation"
          aria-label={menuOpen ? "Close navigation" : "Open navigation"}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span aria-hidden="true" className={menuOpen ? "is-open" : undefined}>
            <i />
            <i />
          </span>
        </button>
      </nav>

      <AnimatePresence initial={false}>
        {menuOpen ? (
          <motion.div
            id="mobile-navigation"
            className="mobile-nav glass-nav"
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: prefersReducedMotion ? 0.01 : 0.2 }}
          >
            <NavigationLinks
              pathname={pathname}
              hash={hash}
              onNavigate={() => setMenuOpen(false)}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
