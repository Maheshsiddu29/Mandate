import { LiveLab } from "@/components/demo/live/live-lab";
import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Mandate — Live AI Lab",
  description:
    "Live AI Lab: model-backed agents act autonomously under a Portfolio Mandate the principal authors; the frozen Mandate path decides what may settle. Runs against a local server; no key in the browser.",
  path: "/demo/live",
});

export default function LiveDemoPage(): ReactNode {
  return <LiveLab />;
}
