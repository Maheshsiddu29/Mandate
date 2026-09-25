# Robinhood Chain integration findings

Empirical basis for the Phase 3 adapter. This document records only the external
facts Mandate relies on; it is not a copy of Robinhood or Chainlink API
documentation.

- **Investigation date:** 2026-09-24 (America/Los_Angeles)
- **Mainnet observation block:** `0x4468e5a` (71,732,826)
- **Mainnet block timestamp:** `2026-09-24T22:36:48Z`
- **Implementation status:** Phase 3 complete; read-only adapter and replay validation implemented

## Sources and observed interfaces

Official sources consulted on 2026-09-24:

- [Robinhood Stock Token API](https://docs.robinhood.com/chain/stock-token-apis/)
- [Stock Token overview](https://docs.robinhood.com/chain/stock-tokens/)
- [Building with Stock Tokens](https://docs.robinhood.com/chain/building-with-stock-tokens/)
- [Robinhood Chain connection details](https://docs.robinhood.com/chain/connecting/)
- [Robinhood Chain oracle guidance](https://docs.robinhood.com/chain/oracles-and-price-feeds/)
- [Robinhood Stock Token disclosures](https://robinhood.com/rhj/stocktokens/)
- [Chainlink Robinhood tokenized-equity feeds](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood)
- [Chainlink Robinhood mainnet feed catalog](https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json)

Direct observations used unauthenticated read-only requests to:

| Surface | Observed endpoint | Documented cache/rate behavior |
| --- | --- | --- |
| Asset catalogue | `GET https://api.robinhood.com/rhj/assets` | cached; no numeric window stated on the inspected page; 60 requests/second shared limit |
| Price | `GET https://api.robinhood.com/rhj/prices/{symbol}` | 15-second cache; 60 requests/second |
| Corporate actions | `GET https://api.robinhood.com/rhj/corporate-actions` | one-hour cache; 60 requests/second |
| Mainnet RPC | Capture: `https://rpc.robinhoodchain.com`; tooling default: `https://rpc.mainnet.chain.robinhood.com` | both returned chain ID 4663; no public rate guarantee relied on |

The API responses returned HTTP 200 through CloudFront. No cache-control or
freshness header was returned in the captured responses, so Mandate does not
infer freshness from HTTP retrieval or CDN state.

## Chain and contract facts

Robinhood documents mainnet chain ID 4663 and testnet chain ID 46630. A direct
`eth_chainId` mainnet read returned `0x1237` (4663). The official public RPC
served historical `eth_call`, `eth_getCode`, and `eth_getLogs` at the fixed
capture block.

Stock Tokens are standard ERC-20 contracts with 18 decimals and ERC-8056 scaled
UI amount views. At the capture block, each sampled deployment had bytecode and
the following documented functions were observed successfully:

```
symbol()
name()
decimals()
uid()
uiMultiplier()
newUIMultiplier()
effectiveAt()
oraclePaused()
```

The observed `uid`, symbol, name, decimals and current multiplier matched the
asset API for the six contracts queried onchain. `oraclePaused()` was false for
all six. No write was attempted.

## Live schema findings and discrepancies

The live `/assets` response contained 195 assets and fields not listed in the
inspected API schema table: `tokenDecimals` and `isin`. Every Phase 3 sample has
a check-digit-valid ISIN, which lets Mandate map the Stock Token to canonical
financial identity without treating its symbol as authority.

The live trading-capability shape was:

```
market | extended | overnight
  -> whole | fractional
      -> TRADING_STATUS_TRADABLE | TRADING_STATUS_UNTRADABLE
```

This agrees with the Stock Token overview but differs from the flat
`fractionalTradability`, `allDayTradability`, and
`extendedHoursFractionalTradability` shape still shown in one API-reference
section. The Phase 3 parser implements the observed nested schema and rejects an
unknown status. Trading capability is recorded independently of trading halt.

The live `/prices` response also contained `tokenBid` and `tokenAsk`, which were
not in the schema table. They matched `bid × currentMultiplier` and
`ask × currentMultiplier` after explicit truncation toward zero to 18 decimal
places. Several sample products had nonzero sub-atom remainders, so treating
the calculation as exactly representable would reject valid observed data.

The captured corporate-action response contained 52 rows: cash dividends only,
with both `IN_PROGRESS` and `COMPLETED` statuses. Other action types are
documented for the wire format but were not observed in this capture. Mandate
parses the documented types and details variants but reports only cash dividends
as empirically observed in the recorded dataset.

No captured asset was inactive, no pending multiplier existed, and no captured
price was halted. Those cases remain clearly labelled synthetic failure worlds;
they are not presented as mainnet observations.

## Identity and representation semantics

The authoritative edge is:

```
Robinhood UID + deployment + validated ISIN -> Mandate CanonicalAssetId
```

Ticker and ERC-20 symbol are cross-checks and display values only. A deployment
is accepted as the expected representation only when chain ID and address come
from Robinhood's asset API and the named contract has code with matching UID,
symbol, name, decimals, and multiplier at the observed block.

Official issuer material says Stock Tokens are tokenized debt securities issued
and tokenized by Robinhood Assets (Jersey) Limited. They provide economic
exposure and are backed 1:1 by corresponding underlying assets held by a
custodian, but confer no legal or beneficial rights in the underlying and no
underlying shareholder voting rights. Cash dividends are reinvested and
reflected through the multiplier rather than paid as cash. Direct issuer
redemption is subject to KYC/AML and availability conditions. Onchain token
transfer settles atomically; issuer redemption is a separate restricted process.

The existing Phase 2 vocabulary can express these findings without a schema
change: `DEBT_INSTRUMENT`, `FULLY_BACKED`, `QUALIFIED_HOLDERS_ONLY`, explicit
per-right states, `ON_CHAIN_MULTIPLIER`, and `ATOMIC_ON_CHAIN`. Mandate does not
claim that a holder owns or beneficially owns the referenced security.

## Price and time semantics

Robinhood's REST `bid` and `ask` are raw underlying-share prices. The conversion
to one raw token's total-return value is:

```
tokenEquivalentPrice = floor(underlyingPriceAtoms * currentMultiplierAtoms / 10^18)
```

where all displayed values use 18 decimal atoms and the floor operation is the
wire behavior verified against `tokenBid` and `tokenAsk`. The adapter names this
rounding rule explicitly; it is not generic safety arithmetic. Chainlink's
feed already publishes this multiplier-adjusted token price with its own
decimals and `updatedAt`; applying the multiplier again would be wrong.

The capture confirmed the multiplier and truncation equation against Robinhood's live
`tokenBid`/`tokenAsk`. The sampled Chainlink rounds were older than their paired
REST quotes, so they are not asserted equal; cross-surface diagnostics label
them time-incomparable instead of manufacturing a mismatch or ignoring time.

The clocks remain distinct:

| Clock | Safety use |
| --- | --- |
| REST `generatedAt` | market observation time and kernel price freshness |
| HTTP retrieval time | capture provenance only |
| block timestamp | age of onchain observations and pending-state activation |
| Chainlink `updatedAt` | onchain price freshness |
| action `processDate` | scheduled/processed issuer date; not quote freshness |
| registry claim `observedAt` | claim freshness |
| verifier clock | explicit evaluation input; never read by an adapter decision |

## Real sample

The initial sample is AAPL, NVDA, TSLA, QQQ, CRWD, MSFT, and WYFI. It covers
equities and an ETF, a multiplier of exactly one, dividend-adjusted multipliers,
CRWD's 4.0 split multiplier, completed and pending cash-dividend rows, and an
asset whose fractional capability is untradable. The selection records what the
capture actually exposed; it does not synthesize missing mainnet states.
WYFI's price endpoint returned HTTP 404 at `2026-09-24T22:57:16Z`; Mandate
therefore retains its asset and capability state but creates no market state.

## Limits

- The asset-catalogue cache duration is undocumented on the inspected page.
- The live response added fields and changed capability shape ahead of one
  schema table; strict parsing therefore makes drift visible.
- The official Chainlink catalogue listed feeds for five of the first six
  onchain samples; CRWD had no catalogue entry at capture time and is `UNKNOWN`
  for that surface.
- A currently active halt, inactive token, and future pending multiplier were
  not observed. Offline synthetic tests cover those failure modes.
- Phase 3 records pending actions and capabilities but does not invent routing
  or long-lived-mandate policy. Those decisions remain later-phase work.

The deterministic dataset and its synthetic-state labelling rules are specified
in [Mainnet replay methodology](mainnet-replay.md).

## Developer commands and network isolation

Normal validation is offline:

```bash
npm test
npm run robinhood:fixtures:validate
npm run mainnet-replay:validate
npm run robinhood:cross-surface
npm run credentials:scan
npm run check
```

Live work is explicit and separate:

```bash
npm run robinhood:live
npm run robinhood:capture -- --output /absolute/new/capture-directory
```

The capture command requires a new output path and refuses to overwrite any
existing path. It captures exact REST response text, fixed-block contract and
ERC-8056 reads, multiplier events, the official feed catalog, and fixed-block
feed reads. Promotion into the committed fixture directory remains a reviewed
operation; capture never updates it implicitly. `ROBINHOOD_RPC_URL` may override
the public HTTPS RPC without storing a provider URL or credential.

The network client distinguishes timeouts, HTTP errors, rate limiting, missing
assets, malformed or partial responses, RPC errors, and chain mismatch. None of
those failures produces trusted state. Live checks are intentionally absent from
`npm test` and `npm run check`.
