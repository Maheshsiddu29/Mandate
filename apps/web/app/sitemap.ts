import { siteConfig } from "@/lib/metadata";
import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [
    "/",
    "/demo",
    "/demo/live",
    "/developers",
    "/docs",
    "/docs/concepts",
    "/docs/execution",
    "/docs/security",
    "/docs/proof",
    "/docs/sdk",
    "/docs/architecture",
    "/docs/reference",
  ] as const;

  return paths.map((path) => ({
    url: new URL(path, siteConfig.url).toString(),
    changeFrequency: "weekly" as const,
    priority: path === "/" ? 1 : path.startsWith("/docs") ? 0.85 : 0.8,
  }));
}
