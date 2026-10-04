/**
 * Mandate documentation site locks: routes, navigation, SDK surface, live V3
 * evidence, fixture qualification, claim hygiene, and accessibility basics.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DOCS_NAV } from "../lib/docs/nav.ts";
import { LIVE_V3_EVIDENCE } from "../lib/docs/evidence.ts";
import {
  SDK_CLIENT_METHODS,
  SDK_PUBLIC_EXPORTS,
  SDK_QUICKSTART,
} from "../lib/docs/sdk-example.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const repo = join(root, "../..");
const appDocs = join(root, "app/docs");
const componentsDocs = join(root, "components/docs");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(path, acc);
    else if (/\.(tsx|ts|css|md)$/.test(entry.name)) acc.push(path);
  }
  return acc;
}

describe("Mandate documentation site", () => {
  it("exposes all eight docs routes", () => {
    for (const item of DOCS_NAV) {
      const rel =
        item.href === "/docs"
          ? "app/docs/page.tsx"
          : `app/docs${item.href.slice("/docs".length)}/page.tsx`;
      assert.ok(statSync(join(root, rel)).isFile(), rel);
    }
    assert.equal(DOCS_NAV.length, 8);
    assert.deepEqual(
      DOCS_NAV.map((item) => item.href),
      [
        "/docs",
        "/docs/concepts",
        "/docs/execution",
        "/docs/security",
        "/docs/proof",
        "/docs/sdk",
        "/docs/architecture",
        "/docs/reference",
      ],
    );
  });

  it("sidebar links match docs routes and resolve in the shell", () => {
    const sidebar = read("components/docs/docs-sidebar.tsx");
    const nav = read("lib/docs/nav.ts");
    for (const item of DOCS_NAV) {
      assert.match(nav, new RegExp(`href: "${item.href}"`));
      assert.match(sidebar, /DOCS_NAV/);
      assert.match(sidebar, /aria-label="Documentation"/);
      assert.match(sidebar, /Docs menu/);
      assert.match(sidebar, /aria-expanded/);
      assert.match(sidebar, /Close docs menu/);
    }
    assert.match(sidebar, /setOpen\(false\)/);
    assert.match(sidebar, /Escape/);
  });

  it("SDK example matches actual @mandate/sdk exports and client methods", () => {
    const sdkIndex = readFileSync(join(repo, "packages/sdk/src/index.ts"), "utf8");
    const sdkClient = readFileSync(join(repo, "packages/sdk/src/client.ts"), "utf8");
    for (const name of SDK_PUBLIC_EXPORTS) {
      assert.match(sdkIndex, new RegExp(`\\b${name}\\b`));
    }
    for (const method of SDK_CLIENT_METHODS) {
      assert.match(sdkClient, new RegExp(`${method}\\(`));
      assert.match(SDK_QUICKSTART, new RegExp(`\\b${method}\\b`));
    }
    assert.match(SDK_QUICKSTART, /createMandateClient/);
    assert.match(SDK_QUICKSTART, /liveLabDomainBindings/);
    const sdkPage = read("app/docs/sdk/page.tsx");
    assert.match(sdkPage, /SDK_QUICKSTART/);
    assert.match(sdkPage, /does not own wallet private keys/);
    assert.match(sdkPage, /silently broadcast/);
  });

  it("live V3 transaction and Gate match committed evidence and manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(repo, "contracts/deploy/robinhood-testnet-delegated-live.json"), "utf8"),
    ) as { gate: string; chainId: number; gateKind: string };
    assert.equal(manifest.chainId, 46630);
    assert.equal(manifest.gate.toLowerCase(), LIVE_V3_EVIDENCE.gate);
    assert.equal(LIVE_V3_EVIDENCE.chainId, 46630);
    assert.equal(
      LIVE_V3_EVIDENCE.transaction,
      "0x95fae11bb545330f03365939dc87a1c39023717a0b00b81ae93ab6a4b25f0878",
    );
    assert.equal(LIVE_V3_EVIDENCE.block, "128655452");
    assert.equal(LIVE_V3_EVIDENCE.gasUsed, "322661");
    assert.equal(LIVE_V3_EVIDENCE.executionNonce, "1");
    assert.equal(
      LIVE_V3_EVIDENCE.delegationDigest,
      "0x46bcaa9574e5d12c03af56fa0f4b980624078b2d4df71b9fd7486afa6a4ff194",
    );
    assert.equal(
      LIVE_V3_EVIDENCE.reservation,
      "0x82d5a8bdbc661e92d62c09d2d404051daa424c7de4f448f83e61e3b786f32e7c",
    );
    assert.equal(
      LIVE_V3_EVIDENCE.receiptDigest,
      "0x93ba1158b1aadb16daf8ede52a95ef6b4ed51bf35bb11c7610776aeda1ad9ebe",
    );
    assert.match(LIVE_V3_EVIDENCE.qualification, /Valueless demo assets/);
    assert.match(LIVE_V3_EVIDENCE.qualification, /Not an NVDA trade/);
    assert.match(LIVE_V3_EVIDENCE.qualification, /Not a Robinhood Stock Token/);
    const proof = read("app/docs/proof/page.tsx");
    assert.match(proof, /LIVE_V3_EVIDENCE/);
    assert.match(proof, /FIXTURE_QUALIFICATION/);
    assert.match(proof, /e\.qualification/);
    assert.match(proof, /NOT CLAIMED/);
    assert.match(proof, /LIVE_MODEL/);
    assert.match(proof, /LIVE_TESTNET/);
    assert.doesNotMatch(proof, /\$800 MDUSD settled|NVDA purchased|trades real NVDA/i);
  });

  it("keeps LIVE_MODEL and LIVE_TESTNET distinct and does not claim mainnet", () => {
    const docsFiles = collectFiles(appDocs).concat(collectFiles(componentsDocs));
    const rendered = docsFiles.map((path) => readFileSync(path, "utf8")).join("\n");
    assert.match(rendered, /LIVE_MODEL/);
    assert.match(rendered, /LIVE_TESTNET/);
    assert.match(rendered, /LIVE_MODEL means a model produced the result/);
    assert.match(rendered, /NOT CLAIMED/);
    assert.doesNotMatch(rendered, /mainnet execution|production ready|fully decentralized|trustless|zero risk|best execution|regulatory compliant|guaranteed|one approval forever|unlimited autonomous trading/i);
    assert.doesNotMatch(rendered, /StateGuard|StateLatch|EquityGuard|stateguard/i);
    assert.doesNotMatch(rendered, /trades real NVDA|Robinhood Stock Token trade/i);
  });

  it("code and hash surfaces avoid horizontal page overflow", () => {
    const css = read("components/docs/docs.css");
    assert.match(css, /\.docs-code__pre\s*\{[^}]*overflow-x:\s*auto/s);
    assert.match(css, /min-width:\s*0/);
    assert.match(css, /\.docs-table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
    assert.match(read("components/docs/docs-code.tsx"), /aria-label=\{copied \? "Copied" : "Copy code"\}/);
    assert.match(read("components/docs/docs-hash.tsx"), /aria-label=\{copied \? `Copied/);
    assert.match(read("components/docs/docs-sidebar.tsx"), /aria-controls=\{panelId\}/);
  });

  it("sitemap and primary nav include Docs routes", () => {
    const sitemap = read("app/sitemap.ts");
    for (const item of DOCS_NAV) {
      assert.match(sitemap, new RegExp(`"${item.href}"`));
    }
    const nav = read("components/layout/nav.tsx");
    assert.match(nav, /label: "Docs", href: "\/docs"/);
    assert.match(nav, /pathname === "\/docs" \|\| pathname\.startsWith\("\/docs\/"\)/);
  });

  it("has no dead internal docs links among docs pages", () => {
    const pages = collectFiles(appDocs).filter((path) => path.endsWith("page.tsx"));
    const hrefs = new Set(DOCS_NAV.map((item) => item.href));
    const linkRe = /href="(\/docs(?:\/[a-z0-9-]+)*)"/g;
    for (const page of pages) {
      const source = readFileSync(page, "utf8");
      for (const match of source.matchAll(linkRe)) {
        const href = match[1]!;
        assert.ok(hrefs.has(href as (typeof DOCS_NAV)[number]["href"]), `${page} → ${href}`);
      }
    }
  });
});
