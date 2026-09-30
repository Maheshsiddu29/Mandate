/**
 * The judge scenario: when each protocol run happens and what the
 * continuation agents want. **Scenario inputs only — no outcome is here.**
 *
 * Scenes 1–5 are the canonical Phase 7F demonstration, unchanged: the same
 * mandate, markets, agents and decision time as `runDemo` (its receipt is
 * the committed `corpus/portfolio-demo-v1` receipt). Every number the demo
 * reports for them is read from that run.
 *
 * Scenes 6–9 continue against the same ledger, later. Their inputs are the
 * few values below — what the compromised agent tries, what it then does
 * properly, and a top-up another agent asks for. Every outcome (blocked,
 * reduced to what, reserved how much) comes from the protocol.
 */

import type { Identifier } from '@mandate/kernel';
import { DEMO_NOW, USDC } from '@mandate/portfolio/demo';

/** The canonical demonstration's decision time: scenes 1–5. */
export const INITIAL_TIME = DEMO_NOW;
/** When the replay probe presents every reserved child again (scene 5). */
export const REPLAY_PROBE_TIME = DEMO_NOW + 10n;
/** Scene 6: the compromised agent's attempt. */
export const ATTACK_TIME = DEMO_NOW + 60n;
/** Scene 8: the same agent's compliant action. */
export const COMPLIANT_TIME = DEMO_NOW + 120n;
/** Scene 9: the portfolio-level conflict. */
export const CONFLICT_TIME = DEMO_NOW + 180n;
/** Agents observe their quotes this long before they propose, as in the canonical run. */
export const QUOTE_LEAD_SECONDS = 10n;
/** A signed proposal's lifetime, as in the canonical run. */
export const PROPOSAL_LIFETIME_SECONDS = 3_600n;

/** The five agents, in the mandate's order. */
export const ROLES = ['stock', 'swap', 'nft', 'yield', 'perps'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Scene 6 and 8: the swap agent is compromised. It keeps its real key,
 * identity and delegation. It first signs a swap paying an attacker; later,
 * the same key signs the same swap paying the principal.
 */
export const COMPROMISED_ROLE: Role = 'swap';
/** A recognisably fictional attacker account on the swap domain's chain. */
export const ATTACKER_RECIPIENT = 'eip155:421614/account:0x9999999999999999999999999999999999999999' as Identifier;
export const CONTINUATION_SWAP_ATOMS = USDC(50n);

/**
 * Scene 9: an agent with room under its own hard maximum asks to top up its
 * approved position by more than the portfolio still has. It accepts any
 * size down to `minimum`.
 */
export const TOP_UP = { role: 'yield' as Role, atoms: USDC(200n), minimum: USDC(25n) } as const;
