# Routing simulation methodology

Phase 4 uses one router for recorded-mainnet replay and generated execution
worlds. A world builder describes inputs and mutations but carries no expected
answer; `packages/router` computes the result.

## Inputs

A run is fixed by a seed, world count, asset set, market-regime set, agent
mutation rate, route-provider fault rate, stale-state rate and corporate-action
rate. The generator is a bigint linear congruential generator and does not use
process randomness or floating point.

The committed run uses the recorded Phase 3 NVDA representation, price,
contract and epoch. Route fees, alternate venue routes and adversarial
mutations are explicitly synthetic. Generated cases include valid-route ties,
fee and freshness comparisons, identity substitutions, stale quotes, halted
state, amount and side mutation, fake contracts, corporate-action changes,
unknown or understated costs and one valid route among malicious proposals.

## Evaluation and reproduction

Each world is evaluated twice, with the route order reversed on the second
run. Metrics are derived from actual outcomes: generated, excluded and valid
candidates; selected and no-route results; reasons; malicious selections;
unsafe execution handoffs; ordering determinism; and receipt reproduction.

`npm run routing-simulation:generate` produces the committed report in
`corpus/routing-simulation-v1`. Its test regenerates the report and requires an
exact match. The scale is deliberately modest; the API can increase the world
count without introducing another decision engine.

The six-asset `corpus/mainnet-routing-v1` uses the same method with AAPL, NVDA,
TSLA, QQQ, CRWD and MSFT recorded snapshots. Each has two valid synthetic cost
routes and one cheaper malicious issuer-substitution route.
