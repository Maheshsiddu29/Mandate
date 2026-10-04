# Judge demo on the web

`apps/web` plays the Milestone A transcript. It does not re-decide it.

The protocol run happens before the site is built:

```sh
npm run web:demo:generate
```

That command runs `npm run demo:judge:json`, checks schema
`MANDATE_JUDGE_DEMO.V1`, version 1, `presentationOnly`, event order, and the
presentation digest, then writes the runner's bytes to
`apps/web/generated/judge-demo.v1.json`.

```sh
npm run web:demo:check
```

compares those bytes with a fresh run and writes nothing. A mismatch fails.

The browser imports that file through `JudgeDemoProvider`. Presentation state
is a cursor: start, pause, resume, next, previous, restart, and scene seek.
Those controls do not call the ledger, a signer, or the network.

## Cloudflare Pages

| Setting | Value |
| --- | --- |
| Root directory | `apps/web` |
| Node.js | `>=22.18.0 <23` |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `out` |
| Required environment variables | none |
| Required secrets | none |

`NEXT_PUBLIC_SITE_URL` may be set at build time for canonical URLs. Judge mode
does not read it. Pages does not run `web:demo:generate`; the committed asset
is the source.

## Documentation (C4)

The site ships a judge/developer documentation tree under `/docs`:

| Route | Page |
| --- | --- |
| `/docs` | Overview |
| `/docs/concepts` | Authority Model |
| `/docs/execution` | Autonomous Execution |
| `/docs/security` | Security Model |
| `/docs/proof` | Proof & Evidence |
| `/docs/sdk` | SDK / Developer Integration |
| `/docs/architecture` | Architecture |
| `/docs/reference` | Reference & Limitations |

This is documentation only. It does not change protocol semantics, compiler
behaviour, V2/V3 Gates, or `@mandate/sdk`. Live V3 proof values on `/docs/proof`
are sourced from the committed Gate manifest and the verified LIVE_TESTNET
session evidence. Stock settlement remains valueless MDUSD → MDEMO fixture
assets — not an NVDA trade and not a Robinhood Stock Token.

The `/developers` route points at `/docs/sdk`. The SDK itself lives in
`packages/sdk`; the browser does not re-implement authority.
