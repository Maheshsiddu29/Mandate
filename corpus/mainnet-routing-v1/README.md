# Mainnet routing replay v1

Six recorded Robinhood mainnet asset snapshots are extended into candidate-set
routing worlds. Representation identity, price, contract, multiplier and
corporate-action epoch are recorded facts. Alternative route fees and venue
choices are explicitly synthetic.

Generate with `npm run mainnet-routing:generate`. Validate with
`npm run mainnet-routing:validate`. Both use the ordinary registry, kernel and
router; there is no corpus-only decision path.
