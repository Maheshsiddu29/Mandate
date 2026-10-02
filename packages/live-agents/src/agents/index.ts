import type { Role } from '../types.ts';
import { NFT_AGENT } from './nft-agent.ts';
import { PERPS_AGENT } from './perps-agent.ts';
import type { DomainAgentSpec } from './spec.ts';
import { STOCK_AGENT } from './stock-agent.ts';
import { SWAP_AGENT } from './swap-agent.ts';
import { YIELD_AGENT } from './yield-agent.ts';

export const DOMAIN_AGENTS: { readonly [R in Role]: DomainAgentSpec } = {
  stock: STOCK_AGENT,
  swap: SWAP_AGENT,
  nft: NFT_AGENT,
  yield: YIELD_AGENT,
  perps: PERPS_AGENT,
};

export { STOCK_AGENT, SWAP_AGENT, NFT_AGENT, YIELD_AGENT, PERPS_AGENT };
export { PROMPT_INJECTION_FIXTURE } from './nft-agent.ts';
export * from './spec.ts';
export * from './eligibility.ts';
export * from './capability.ts';
