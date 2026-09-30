/**
 * @mandate/judge-demo — buildathon Milestone A: the judge-facing Mandate demo
 * (docs/demo/judge-demo.md).
 *
 * A thin orchestration layer over the frozen Portfolio Mandate. It runs the
 * real protocol once — offline, deterministic, no transaction — and turns
 * what the protocol returned into the `MANDATE_JUDGE_DEMO.V1` event
 * transcript a UI plays back. It holds no authority and decides nothing:
 * every outcome it reports is one the Mandate code produced.
 */

export * from './events.ts';
export * from './playback.ts';
