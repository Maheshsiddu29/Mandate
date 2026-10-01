import { LandingPage } from "@/components/landing/landing-page";
import { createMetadata } from "@/lib/metadata";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = createMetadata({
  title: "Mandate — One authority layer for autonomous markets",
  description:
    "Give specialized agents room to find, negotiate and execute opportunities across markets — without giving them unlimited control of your assets.",
  path: "/",
});

export const viewport: Viewport = {
  themeColor: "#120F17",
};

export default function HomePage(): ReactNode {
  return <LandingPage />;
}
