/**
 * Mandate documentation information architecture.
 *
 * Eight visible pages. Deeper structure uses in-page anchors, not extra routes.
 */

export type DocsHref =
  | "/docs"
  | "/docs/concepts"
  | "/docs/execution"
  | "/docs/security"
  | "/docs/proof"
  | "/docs/sdk"
  | "/docs/architecture"
  | "/docs/reference";

export type DocsNavItem = {
  readonly href: DocsHref;
  readonly label: string;
  readonly title: string;
  readonly description: string;
};

export const DOCS_NAV: readonly DocsNavItem[] = [
  {
    href: "/docs",
    label: "Overview",
    title: "Overview",
    description:
      "Mandate is authorization infrastructure for autonomous financial agents.",
  },
  {
    href: "/docs/concepts",
    label: "Authority Model",
    title: "Authority Model",
    description:
      "How principal authority becomes bounded agent authority without silent clipping.",
  },
  {
    href: "/docs/execution",
    label: "Autonomous Execution",
    title: "Autonomous Execution",
    description:
      "One reusable Mandate signature, bounded settlement allowance, and V3 delegated execution.",
  },
  {
    href: "/docs/security",
    label: "Security",
    title: "Security Model",
    description:
      "A valid agent is not automatically authorized to perform a valid action.",
  },
  {
    href: "/docs/proof",
    label: "Proof & Evidence",
    title: "Proof & Evidence",
    description:
      "Evidence classes, the proof stack, and the current LIVE_TESTNET V3 settlement.",
  },
  {
    href: "/docs/sdk",
    label: "SDK",
    title: "SDK / Developer Integration",
    description:
      "Integrate external agents through the thin @mandate/sdk facade.",
  },
  {
    href: "/docs/architecture",
    label: "Architecture",
    title: "Architecture",
    description:
      "Authorization pipeline, package dependency direction, and advisory model boundaries.",
  },
  {
    href: "/docs/reference",
    label: "Reference",
    title: "Reference & Limitations",
    description:
      "Chain facts, evidence labels, current limitations, and glossary.",
  },
] as const;

export function docsItem(href: DocsHref): DocsNavItem {
  const item = DOCS_NAV.find((entry) => entry.href === href);
  if (!item) {
    throw new Error(`Unknown docs route: ${href}`);
  }
  return item;
}

export function docsNeighbors(href: DocsHref): {
  readonly prev: DocsNavItem | null;
  readonly next: DocsNavItem | null;
} {
  const index = DOCS_NAV.findIndex((entry) => entry.href === href);
  return {
    prev: index > 0 ? DOCS_NAV[index - 1]! : null,
    next: index >= 0 && index < DOCS_NAV.length - 1 ? DOCS_NAV[index + 1]! : null,
  };
}

export function isDocsPath(pathname: string): boolean {
  return pathname === "/docs" || pathname.startsWith("/docs/");
}
