import { siteConfig } from "@/lib/metadata";
import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/demo", "/developers", "/docs"].map((path) => ({
    url: new URL(path, siteConfig.url).toString(),
    changeFrequency: "weekly" as const,
    priority: path === "/" ? 1 : 0.8,
  }));
}
