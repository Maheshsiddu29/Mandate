/**
 * Local signers — the only module in this package that touches a key.
 *
 * Every key is a Phase 7F **demonstration** key (`@mandate/portfolio/demo`):
 * derived from a public label, it secures nothing and must never hold
 * value. It lives in a private field, is never returned, logged, serialized,
 * put in a prompt, sent to a provider, to JEV or to the browser.
 *
 * A model decides *what* to ask for; trusted code builds the exact
 * proposal; a signer here signs that canonical proposal and nothing else.
 * An agent signer refuses to sign for any party but its own, so one agent's
 * key can never speak for another agent's proposal.
 */

import {
  mandateSigningHash,
  portfolioMandateDigest,
  proposalDigest,
  proposalSigningHash,
  type AgentProposal,
  type PortfolioMandate,
  type SignedProposal,
} from '@mandate/portfolio';
import { demoKey, demoParty, signPrehash } from '@mandate/portfolio/demo';
import { ROLES, type Role } from '../types.ts';

export interface Party {
  readonly kind: string;
  readonly value: string;
}

export class LocalAgentSigner {
  readonly role: Role;
  readonly party: Party;
  readonly #key: string;
  #uses = 0;

  constructor(role: Role) {
    this.role = role;
    this.party = demoParty(role);
    this.#key = demoKey(role);
  }

  /** Signs a proposal's domain-separated digest, if the proposal is this agent's own. */
  sign(p: AgentProposal): SignedProposal {
    if (p.agent.kind !== this.party.kind || p.agent.value !== this.party.value) throw new Error(`the ${this.role} signer will not sign for another agent`);
    this.#uses += 1;
    return { proposal: p, signature: signPrehash(proposalSigningHash(proposalDigest(p)), this.#key) };
  }

  /** How many signatures this key has made. */
  get uses(): number {
    return this.#uses;
  }

  toJSON(): { readonly role: Role; readonly party: Party } {
    return { role: this.role, party: this.party };
  }
}

/** One signer per role: the swap agent and the rogue agent share the swap signer by construction. */
export function createAgentSigners(): ReadonlyMap<Role, LocalAgentSigner> {
  return new Map(ROLES.map((r) => [r, new LocalAgentSigner(r)]));
}

/**
 * The principal's demonstration key. It signs a mandate only when
 * `MandateVersions.authorize` has been given the principal's explicit
 * confirmation. It is not a wallet signature.
 */
export class LocalPrincipalSigner {
  readonly party: Party = demoParty('principal');
  readonly #key: string = demoKey('principal');
  #uses = 0;

  signMandate(m: PortfolioMandate): string {
    if (m.principal.kind !== this.party.kind || m.principal.value !== this.party.value) throw new Error('the principal signer signs only its own mandates');
    this.#uses += 1;
    return signPrehash(mandateSigningHash(portfolioMandateDigest(m)), this.#key);
  }

  get uses(): number {
    return this.#uses;
  }

  toJSON(): { readonly party: Party } {
    return { party: this.party };
  }
}

export const PRINCIPAL_SIGNATURE_LABEL = 'Demonstration principal key (publicly derived; not a wallet signature; secures nothing)';
