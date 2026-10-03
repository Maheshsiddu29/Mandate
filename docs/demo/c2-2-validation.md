# C2.2 — Validation record

> **Status: Milestone C2.2 implemented locally against design
> [c2-2-demo-ux-polish.md](./c2-2-demo-ux-polish.md).** Presentation polish
> only. No protocol, Review gating, settlement construction, or contract
> changes. No broadcasts by the agent.

## What shipped

| Area | Change |
| --- | --- |
| Compose | Product question, judge examples, Interpreting mandate… |
| Shell | Subtle Define→Review→Authorize→Live→Receipt progress |
| Review / Authorize | You’re authorizing · Needs input / Not supported / Refused |
| Permissions | Financial labels; trusted execution absent from editor |
| Planning | Planning Room vs Agent plan; lighter single-agent copy |
| Active | Mandate active + one-authority→agents map |
| Actions | PROPOSED / AUTHORIZED / BLOCKED / NO ACTION |
| Receipt | Semantic action first; MDUSD→MDEMO proof second; Technical proof |
| CTAs | Start new mandate (fresh session); demoted firewall / Run again |

## Security / authority regression

Unchanged by design:

- MandateDraft compilation / issue policy
- `review.canAuthorize` / `REVIEW_BLOCKED` / `draftKey`
- Settlement construction, SendGate, held / consumed semantics
- Contracts and frozen judge digest

## Automated validation

- `npm run typecheck`
- `npm test` (repo)
- `npm run check`
- `npm run web:demo:check`
- `npm run audit:security`
- `npm run credentials:scan`
- `npm run repository:junk`
- `apps/web` lint / typecheck / test / production build

## Manual acceptance (operator)

Primary target: laptop ~1280–1440. Prefer stop-before-send.

| Flow | Prompt / path | Expect |
| --- | --- | --- |
| A | Stock $800 | Agent plan · authorize · settlement CTA |
| B | Stock+Yield split $2k | Planning Room · plan · sign |
| C | Hybrid remainder | Fixed + flexible |
| D | Manage $2k conservatively | Needs input · Authorize disabled |
| E | $5k + per-trade $500 | Not supported visible |
| F | send to 0x… | Refused · no authorize |
| G | Blocked scenario | Blocked · Wallet/Tx None |
| H | Held restore | Execution held · Check status |
| I | Settled restore | Receipt · no Execute |

## Visual notes

- Viewport intended: 1280–1440
- Progress cue hidden below 960px width
- Console: not re-verified in headless agent session (run `npm run agents:lab` + `apps/web` locally)
- Known limit: conflict coordination sheet still available under Developer / trail

## Non-claims

Does not prove mainnet settlement, NVDA stock token purchase, or new agent
capabilities. Fixture qualification remains on the receipt.
