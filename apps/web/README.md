# Mandate public web app

This directory is the static public website for Mandate. It plays the
canonical judge-demo transcript. It does not run the protocol.

Routes: `/`, `/demo`, `/demo/live`, `/developers`, and `/docs`.

## Local development

Use Node.js 22.18 or newer, and stay below Node 23. Install and run from this
directory so the app uses its own lockfile.

```sh
npm ci
npm run dev
```

`npm run build` writes a static export to `out/`. `next start` does not serve
that export. Preview the production files with any static file server pointed
at `out/`.

## Transcript asset

The browser plays `generated/judge-demo.v1.json`. That file is produced from
the repository root, before the site is built:

```sh
npm run web:demo:generate
npm run web:demo:check
```

Cloudflare Pages does not run those commands. The committed asset is the
playback source. Regenerate it when the judge-demo transcript changes, then
commit the new file.

## Cloudflare Pages

- Root Directory: `apps/web`
- Node.js: 22.x (`>=22.18.0 <23`)
- Install Command: `npm ci`
- Build Command: `npm run build`
- Output Directory: `out`
- Required environment variables: none
- Required secrets: none

Judge mode needs no wallet, no API key, and no runtime environment variable.
`NEXT_PUBLIC_SITE_URL` is optional and only affects canonical and Open Graph
URLs baked in at build time. If it is unset, those URLs fall back to
`http://localhost:3000`.

## What the site is

The `/demo` route is a presentation cursor over the generated transcript.
Playback does not re-run Mandate, read a key, or call a network. Historical
explorer links are optional. The demo still plays if the explorer is down.

`/developers` is a placeholder for a later integration surface. It is not an SDK.

## Live AI Lab (`/demo/live`)

`/demo/live` is the Live AI Lab client (docs/demo/live-ai-lab.md). It is a
static page that talks only to a local server started from the repository
root:

```sh
npm run agents:serve
```

That server binds to `127.0.0.1:8787`, holds `OPENAI_API_KEY` when one is set
(otherwise it offers only the deterministic stub provider), calls the model
provider server-side, and streams `MANDATE_LIVE_AI.V1` events. The browser
bundle contains no key and no provider endpoint. `NEXT_PUBLIC_LIVE_AGENTS_URL`
may point the page at another loopback port; any non-loopback URL is refused.
The Cloudflare Pages build needs no variable or secret for this route; without
a local server the page says the server is unreachable. Nothing is deployed for
the Live AI Lab in this milestone.
