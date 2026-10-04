import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";

const APP_URL = new URL("../app/", import.meta.url);
const COMPONENT_URL = new URL("../components/", import.meta.url);
const PUBLIC_URL = new URL("../public/", import.meta.url);

test("the public app exposes the judge demo, developer placeholder, and docs", async () => {
  const rootEntries = await readdir(APP_URL, { withFileTypes: true });
  const nestedRouteNames = rootEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("_"))
    .sort();

  assert.deepEqual(nestedRouteNames, ["demo", "developers", "docs"]);
  await Promise.all([
    readFile(new URL("page.tsx", APP_URL), "utf8"),
    readFile(new URL("demo/page.tsx", APP_URL), "utf8"),
    readFile(new URL("developers/page.tsx", APP_URL), "utf8"),
    readFile(new URL("docs/page.tsx", APP_URL), "utf8"),
  ]);
});

test("the public demo plays the judge transcript without a network call", async () => {
  const pageSource = await readFile(new URL("demo/page.tsx", APP_URL), "utf8");
  const componentSource = await readFile(
    new URL("demo/judge/judge-experience.tsx", COMPONENT_URL),
    "utf8"
  );
  const stageSource = await readFile(new URL("demo/judge/stage.tsx", COMPONENT_URL), "utf8");

  assert.match(pageSource, /JudgeExperience/);
  assert.doesNotMatch(pageSource, /kox-trade-replay|ActivationPhaseChanged|sendTransaction/);
  assert.match(componentSource, /Judge mode/);
  assert.match(componentSource, /useReducedMotion/);
  assert.match(stageSource, /not a live market/);
  assert.match(componentSource, /role="progressbar"/);
  assert.doesNotMatch(`${componentSource}\n${stageSource}`, /fetch\(|sendTransaction|signTransaction/);
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
  assert.match(heroSource, /Agents propose\. Agents negotiate\. Mandate authorizes\. Markets settle\./);
  assert.match(heroSource, /href="\/demo\/live"/);
  assert.match(heroSource, /Launch Live Demo/);
  assert.match(heroSource, /<HeroWaves/);
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

test("the hero surface is React Bits Pattern Waves and respects motion and visibility", async () => {
  const [waves, hero] = await Promise.all([
    readFile(new URL("react-bits/pattern-waves.tsx", COMPONENT_URL), "utf8"),
    readFile(new URL("mandate/hero-waves.tsx", COMPONENT_URL), "utf8"),
  ]);

  assert.match(waves, /reactbits\.dev\/r\/PatternWaves-TS-CSS\.json/);
  assert.match(waves, /prefers-reduced-motion: reduce/);
  assert.match(waves, /IntersectionObserver/);
  assert.match(waves, /ResizeObserver/);
  assert.match(waves, /visibilitychange/);
  assert.match(waves, /cancelAnimationFrame\(raf\)/);
  assert.match(waves, /resizeObserver\.disconnect\(\)/);
  assert.match(waves, /WEBGL_lose_context/);
  assert.match(hero, /ssr: false/);
  assert.match(hero, /preset: "silk"/);
  assert.match(hero, /color: "#6366F1"/);
  assert.match(hero, /backgroundColor: "#120F17"/);
});

test("the public routes stay on the dark Mandate surface", async () => {
  const demoSource = await readFile(
    new URL("demo/judge/judge-experience.tsx", COMPONENT_URL),
    "utf8"
  );
  const docsLayoutSource = await readFile(new URL("docs/layout.tsx", APP_URL), "utf8");
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
  assert.match(demoSource, /judge-demo/);
  assert.match(docsLayoutSource, /mandate-docs/);
  assert.doesNotMatch(`${demoSource}\n${docsSource}\n${docsLayoutSource}`, /StateGuard|Solana/);
  assert.match(visualSystem, /Manrope Variable/);
  assert.match(visualSystem, /--public-gradient-surface/);
});

test("the docs describe Mandate authority without old product claims", async () => {
  const pageSource = await readFile(new URL("docs/page.tsx", APP_URL), "utf8");
  const conceptsSource = await readFile(new URL("docs/concepts/page.tsx", APP_URL), "utf8");
  const proofSource = await readFile(new URL("docs/proof/page.tsx", APP_URL), "utf8");

  assert.match(pageSource, /Build agents that can act without giving them unlimited authority/);
  assert.match(pageSource, /Authentication is not authorization/);
  assert.match(conceptsSource, /ticker is not a canonical asset identity/i);
  assert.match(proofSource, /LIVE_TESTNET/);
  assert.match(proofSource, /NOT CLAIMED/);
  assert.doesNotMatch(
    `${pageSource}\n${conceptsSource}\n${proofSource}`,
    /StateGuard|EquityGuard|Solana|19,986/,
  );
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
    readFile(new URL("demo/judge/judge-experience.tsx", COMPONENT_URL), "utf8"),
    readFile(new URL("developers/page.tsx", APP_URL), "utf8"),
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
  assert.match(readmeSource, /Output Directory: `out`/);
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
