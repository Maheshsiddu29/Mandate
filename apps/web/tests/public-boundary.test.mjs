import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";

const APP_URL = new URL("../app/", import.meta.url);
const COMPONENT_URL = new URL("../components/", import.meta.url);
const PUBLIC_URL = new URL("../public/", import.meta.url);

test("the public app exposes exactly the three requested page routes", async () => {
  const rootEntries = await readdir(APP_URL, { withFileTypes: true });
  const nestedRouteNames = rootEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("_"))
    .sort();

  assert.deepEqual(nestedRouteNames, ["demo", "docs"]);
  await Promise.all([
    readFile(new URL("page.tsx", APP_URL), "utf8"),
    readFile(new URL("demo/page.tsx", APP_URL), "utf8"),
    readFile(new URL("docs/page.tsx", APP_URL), "utf8"),
  ]);
});

test("the public demo is a scripted mandate review", async () => {
  const pageSource = await readFile(new URL("demo/page.tsx", APP_URL), "utf8");
  const componentSource = await readFile(
    new URL("demo/mandate-demo.tsx", COMPONENT_URL),
    "utf8"
  );

  assert.match(pageSource, /MandateDemo/);
  assert.doesNotMatch(pageSource, /kox-trade-replay|ActivationPhaseChanged|sendTransaction/);
  assert.match(componentSource, /Scripted walkthrough/);
  assert.match(componentSource, /not live markets/);
  assert.match(componentSource, /role="tablist"/);
  assert.match(componentSource, /prefersReducedMotion/);
  assert.doesNotMatch(componentSource, /fetch\(|sendTransaction|signTransaction/);
});

test("the landing page tells the Mandate product story", async () => {
  const pageSource = await readFile(new URL("page.tsx", APP_URL), "utf8");
  const landingSource = await readFile(
    new URL("landing/landing-page.tsx", COMPONENT_URL),
    "utf8"
  );
  const heroSource = await readFile(
    new URL("mandate/hero.tsx", COMPONENT_URL),
    "utf8"
  );

  assert.match(pageSource, /<LandingPage\s*\/>/);
  assert.match(heroSource, /One authority layer/);
  assert.match(heroSource, /for autonomous markets/);
  assert.match(heroSource, /Agents propose\. Mandate authorizes\. Markets settle\./);
  assert.match(landingSource, /WhyMandate/);
  assert.match(landingSource, /CanonicalAssets/);
  assert.match(landingSource, /AuthorityPipeline/);
  assert.match(landingSource, /Infrastructure/);
  assert.doesNotMatch(landingSource, /StateGuard|Solana|19,986|KOx/);
});

test("landing claims stay inside the mock mandate boundary", async () => {
  const source = await readFile(
    new URL("mandate/infrastructure.tsx", COMPONENT_URL),
    "utf8"
  );

  assert.match(source, /LIVE TESTNET|live testnet/i);
  assert.match(source, /fixtures/);
  assert.match(source, /not live markets/);
  assert.doesNotMatch(source, /mainnet execution|StateGuard/i);
});

test("the hero field pauses outside the viewport and when motion is reduced", async () => {
  const fieldSource = await readFile(
    new URL("mandate/authorization-field.tsx", COMPONENT_URL),
    "utf8"
  );

  assert.match(fieldSource, /prefersReducedMotion/);
  assert.match(fieldSource, /IntersectionObserver/);
  assert.match(fieldSource, /visibilitychange/);
  assert.match(fieldSource, /SOURCE_COUNT = 5/);
});

test("the public routes stay on the dark Mandate surface", async () => {
  const demoSource = await readFile(
    new URL("demo/mandate-demo.tsx", COMPONENT_URL),
    "utf8"
  );
  const docsSource = await readFile(new URL("docs/page.tsx", APP_URL), "utf8");
  const backdropSource = await readFile(
    new URL("layout/page-backdrop.tsx", COMPONENT_URL),
    "utf8"
  );
  const visualSystem = await readFile(
    new URL("ui/public-visual-system.css", COMPONENT_URL),
    "utf8"
  );

  assert.doesNotMatch(backdropSource, /grid/);
  assert.match(demoSource, /mandate-demo/);
  assert.match(docsSource, /mandate-docs/);
  assert.doesNotMatch(`${demoSource}\n${docsSource}`, /StateGuard|Solana/);
  assert.match(visualSystem, /Manrope Variable/);
  assert.match(visualSystem, /--public-gradient-surface/);
});

test("the docs describe Mandate authority without old product claims", async () => {
  const pageSource = await readFile(new URL("docs/page.tsx", APP_URL), "utf8");

  for (const section of ["overview", "authority", "pipeline", "assets", "markets", "demo", "build", "limits"]) {
    assert.match(pageSource, new RegExp(`id="${section}"`));
  }

  assert.match(pageSource, /Authentication is not authorization/);
  assert.match(pageSource, /A ticker is not an asset identity/);
  assert.match(pageSource, /not live markets/);
  assert.match(pageSource, /not evidence of a production deployment/);
  assert.doesNotMatch(pageSource, /StateGuard|EquityGuard|Solana|19,986/);
});

test("the public shell uses the approved final brand assets", async () => {
  const [navSource, footerSource, brandSource, layoutSource] = await Promise.all([
    readFile(new URL("layout/nav.tsx", COMPONENT_URL), "utf8"),
    readFile(new URL("layout/site-footer.tsx", COMPONENT_URL), "utf8"),
    readFile(new URL("brand/brand-logo.tsx", COMPONENT_URL), "utf8"),
    readFile(new URL("layout.tsx", APP_URL), "utf8"),
  ]);

  assert.match(navSource, /<BrandLogo\s*\/>/);
  assert.doesNotMatch(navSource, /brand-mark__symbol/);
  assert.doesNotMatch(navSource, />\s*E\s*</);
  assert.match(footerSource, /<BrandLogo\s*\/>/);
  assert.match(layoutSource, /<SiteFooter\s*\/>/);
  assert.match(brandSource, /mandate-mark\.svg/);
  assert.match(brandSource, /Mandate/);
  assert.doesNotMatch(brandSource, /equityguard-logo\.svg/);
  assert.doesNotMatch(brandSource, /stateguard-mark\.svg/);
  assert.doesNotMatch(brandSource, /StateLatch/i);
  assert.doesNotMatch(brandSource, /EquityGuard/);

  const mark = await readFile(new URL("brand/mandate-mark.svg", PUBLIC_URL), "utf8");
  assert.match(mark, /aria-label="Mandate"/);
  assert.doesNotMatch(mark, /EquityGuard|StateLatch|StateGuard/i);
});

test("public routes use the Mandate name", async () => {
  const sources = await Promise.all([
    readFile(new URL("page.tsx", APP_URL), "utf8"),
    readFile(new URL("demo/page.tsx", APP_URL), "utf8"),
    readFile(new URL("docs/page.tsx", APP_URL), "utf8"),
    readFile(new URL("not-found.tsx", APP_URL), "utf8"),
    readFile(new URL("landing/landing-page.tsx", COMPONENT_URL), "utf8"),
    readFile(new URL("mandate/hero.tsx", COMPONENT_URL), "utf8"),
    readFile(new URL("layout/nav.tsx", COMPONENT_URL), "utf8"),
    readFile(new URL("layout/site-footer.tsx", COMPONENT_URL), "utf8"),
    readFile(new URL("demo/mandate-demo.tsx", COMPONENT_URL), "utf8"),
    readFile(new URL("../lib/metadata.ts", import.meta.url), "utf8"),
  ]);
  const visible = sources.join("\n");

  assert.match(visible, /Mandate/);
  assert.doesNotMatch(visible, /StateGuard|StateLatch|EquityGuard/i);
});

test("production metadata, icons, social preview, and 404 are complete", async () => {
  const [metadataSource, manifestSource, notFoundSource, readmeSource, ignoreSource] =
    await Promise.all([
      readFile(new URL("../lib/metadata.ts", import.meta.url), "utf8"),
      readFile(new URL("manifest.ts", APP_URL), "utf8"),
      readFile(new URL("not-found.tsx", APP_URL), "utf8"),
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readFile(new URL("../.gitignore", import.meta.url), "utf8"),
    ]);

  assert.match(metadataSource, /Mandate — Authorization for agent-native markets/);
  assert.match(metadataSource, /summary_large_image/);
  assert.match(metadataSource, /opengraph-image\.png/);
  assert.match(metadataSource, /NEXT_PUBLIC_SITE_URL/);
  assert.match(metadataSource, /VERCEL_PROJECT_PRODUCTION_URL/);
  assert.match(manifestSource, /apple-icon\.png/);
  assert.match(manifestSource, /display: "standalone"/);
  assert.match(notFoundSource, /Page not found/);
  assert.match(notFoundSource, /Back to Mandate/);
  assert.match(readmeSource, /Root Directory: `apps\/web`/);
  assert.match(readmeSource, /Output Directory: leave unset/);
  assert.match(ignoreSource, /^next-env\.d\.ts$/m);

  const openGraphImage = await readFile(new URL("opengraph-image.png", APP_URL));
  assert.equal(openGraphImage.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(openGraphImage.readUInt32BE(16), 1200);
  assert.equal(openGraphImage.readUInt32BE(20), 630);
  assert.ok(openGraphImage.byteLength < 500_000);

  for (const path of ["favicon.ico", "icon.svg", "apple-icon.png"]) {
    assert.ok((await stat(new URL(path, APP_URL))).size > 0);
  }
});
