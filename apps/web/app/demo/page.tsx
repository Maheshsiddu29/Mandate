import { JudgeExperience } from "@/components/demo/judge/judge-experience";
import { createMetadata } from "@/lib/metadata";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Mandate Demo — Portfolio Mandate",
  description:
    "Judge mode plays the deterministic Mandate transcript: five agents, the Mandate Room, independent verification, and a portfolio receipt. No wallet and no network.",
  path: "/demo",
});

export default function DemoPage(): ReactNode {
  return <JudgeExperience />;
}
