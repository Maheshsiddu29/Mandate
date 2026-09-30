"use client";

import { features } from "@/lib/config";
import { useReducedMotion } from "@/lib/motion";
import Lenis from "lenis";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

const LENIS_OPTIONS = {
  duration: 1.25,
  easing: (time: number) => Math.min(1, 1.001 - Math.pow(2, -10 * time)),
  orientation: "vertical" as const,
  gestureOrientation: "vertical" as const,
  smoothWheel: true,
  wheelMultiplier: 0.9,
  touchMultiplier: 1.4,
};

const NAV_OFFSET = -112;

function hashId(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) {
    return "";
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

function hashDestination(): HTMLElement | null {
  const id = hashId(window.location.hash);
  return id ? document.getElementById(id) : null;
}

export function SmoothScroll({ children }: { children: ReactNode }): ReactNode {
  const pathname = usePathname();
  const prefersReducedMotion = useReducedMotion();
  const lenisRef = useRef<Lenis | null>(null);

  useEffect(() => {
    if (!features.smoothScroll || prefersReducedMotion) {
      return;
    }

    const lenis = new Lenis(LENIS_OPTIONS);
    lenisRef.current = lenis;
    let animationFrame = 0;

    const update = (time: number): void => {
      lenis.raf(time);
      animationFrame = requestAnimationFrame(update);
    };

    const scrollToHash = (): void => {
      const destination = hashDestination();
      if (!destination) {
        return;
      }
      lenis.scrollTo(destination, { offset: NAV_OFFSET });
    };

    const handleAnchorClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) {
        return;
      }

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== window.location.pathname) {
        return;
      }

      const id = hashId(url.hash);
      if (!id) {
        return;
      }

      const destination = document.getElementById(id);
      if (!destination) {
        return;
      }

      event.preventDefault();
      if (window.location.hash === `#${id}`) {
        lenis.scrollTo(destination, { offset: NAV_OFFSET });
        return;
      }
      window.location.hash = id;
    };

    animationFrame = requestAnimationFrame(update);
    const initialFrame = requestAnimationFrame(scrollToHash);
    document.addEventListener("click", handleAnchorClick);
    window.addEventListener("hashchange", scrollToHash);

    return () => {
      document.removeEventListener("click", handleAnchorClick);
      window.removeEventListener("hashchange", scrollToHash);
      cancelAnimationFrame(animationFrame);
      cancelAnimationFrame(initialFrame);
      lenisRef.current = null;
      lenis.destroy();
    };
  }, [prefersReducedMotion]);

  useEffect(() => {
    if (!features.smoothScroll || prefersReducedMotion) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      const destination = hashDestination();
      if (!destination) {
        return;
      }
      lenisRef.current?.scrollTo(destination, { offset: NAV_OFFSET });
    });

    return () => cancelAnimationFrame(frame);
  }, [pathname, prefersReducedMotion]);

  return children;
}
