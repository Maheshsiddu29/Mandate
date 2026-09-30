import { MandateDemo } from "@/components/demo/mandate-demo";
import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Mandate Demo — One portfolio review",
  description:
    "A scripted walkthrough of one portfolio mandate, from five agent proposals through policy verification to a receipt. Not a live market execution.",
  path: "/demo",
});

export default function DemoPage(): ReactNode {
  return <MandateDemo />;
}
