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

The `/developers` route is a placeholder. It is not an SDK.
