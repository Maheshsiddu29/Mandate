# C2.2 — Production Demo UX Polish

> **Status: Milestone C2.2 design, opened 2026-10-03 against HEAD
> `10987b178d60d07e8dab9f97fedf6425420ddece` on
> `cursor/c2-2-demo-ux-polish`.**
> Presentation, interaction, hierarchy, motion, copy, and demo coherence
> only. Does **not** change MandateDraft semantics, Review gating,
> settlement construction, contracts, or C1/C2.0/C2.1 authority rules.

```text
Agents propose.
Agents negotiate.
Mandate authorizes.
Markets settle.
```

---

## 1. Current flow

```text
PROMPT (Compose)
  → DRAFTING (compiler)
  → CONFIGURE (agent team / allocation / issues)
  → PLANNING (Planning Room or Agent plan)   [when required]
  → APPROVE (C2.1 Mandate review + Authorize)
  → AGENTS_WORKING / MANDATE_REVIEW / ROOM / VERIFYING
  → AUTHORIZED
  → SETTLING | COMPLETE (receipt + settlement CTA)
  → FAILED
```

Primary surface: `apps/web/components/demo/live/*` on `/demo/live`.
Shell: top bar (Live demo + status), optional trail, one animated stage,
thesis line, sheets (permissions, review, agents, room, stress, events, pause).

Functional baseline preserved: C1 settlement, C2.0 compiler, C2.1 Review.

---

## 2. UX problems (prioritized)

| Priority | Problem | Where |
| --- | --- | --- |
| P0 | Compose headline close but not the product line (“What should…” vs “What do you want…”) | `stage-compose.tsx` |
| P0 | After authorize, “Authorized portfolio” / “Agents are working” under-sell Mandate Active | `stage-outcome.tsx`, `stage-agents.tsx` |
| P0 | Receipt mixes agent outcomes, settlement proof, and digests with similar weight | `ReceiptStage` |
| P0 | “Run again” can be read as replaying a consumed reservation | receipt / failed footers |
| P1 | Trail shows `Mandate V{n}` and wallet-principal jargon | `live-lab.tsx` |
| P1 | Settlement unavailable copy mentions “V2 settlement spine” | `live-lab.tsx` |
| P1 | Review blockers visually hot (red panel) for every category | CSS + ApproveStage |
| P1 | Configure still competes with Review for “authority understanding” | `ConfigureStage` |
| P2 | Suggestion chips are fragment-like, not judge prompts | `SUGGESTIONS` |
| P2 | Drafting says “Building your mandate” not real interpretation states | `DraftingStage` |
| P2 | Agent ABSTAIN line is flat; not clearly “normal / capital remains” | `stage-agents.tsx` |
| P2 | Permissions still feel field-path heavy in places | `PermissionsBody` |
| P3 | Thesis footer always visible; can clutter mid-flow | `live-lab.tsx` |
| P3 | Multi-agent “one authority → many agents” not glanceable | missing diagram |

---

## 3. Unnecessary technical surfaces (primary UI)

Demote to Technical proof / Developer menu only:

- “spine”, “V2 settlement spine”
- `Mandate V{n}` as a primary label (keep as subtle version if needed)
- reservation / allocation / gate mandate digests in the open receipt
- `WALLET_PRINCIPAL_V2*` method strings
- session ids in the main settling header
- Event log / Security demo as primary CTAs after settle
- Protocol phase names in status copy

Keep visible in Technical proof: digests, addresses, gas, atoms, chain ID.

---

## 4. Confusing terminology

| Current (primary) | Prefer |
| --- | --- |
| Building mandate | Interpreting mandate… / Ready to review |
| Authorized portfolio | Mandate active |
| Agents are working | Mandate active · agents operating |
| Run again | Start new mandate (fresh session) |
| Adjust mandate | Edit mandate (secondary) |
| V2 settlement spine | Settlement unavailable (local server) |
| Mandate V3 · … | Authorized capital summary |
| Reservation consumed (open) | under Technical proof / verification list |
| SPINE_* in user lines | already partly mapped; finish mapping |

---

## 5. Duplicate information

- Capital total in Compose notes, Configure allocation, Review, trail, receipt
- Agent enabled state in Configure + Review + trail
- Settlement status in Settling header + steps + proof pill
- Multiple “nothing was broadcast” lines stacked on held/failed

**Rule:** one primary capital figure per stage; trail is summary only; receipt leads with semantic action then proof.

---

## 6. Information hierarchy

| Stage | Primary | Secondary | Tertiary |
| --- | --- | --- | --- |
| Compose | Prompt | Example chips | Server offline |
| Review | Portfolio + agents + allocation | Risk / advanced | Provenance, tech |
| Plan | Available capital + proposals | Scores / rationale | — |
| Authorize | Exact authority being signed | Wallet / demo method | EIP-712 details |
| Active | Agent states under approved authority | Activity lines | Codes in details |
| Settle | Progress steps + CTA | Qualification | Digests |
| Receipt | SETTLED + NVDA semantic | MDUSD→MDEMO proof | Technical proof |

---

## 7. Motion plan

Keep `motion/react` + LatticeLoader. Honor `prefers-reduced-motion` / existing `reduced`.

| Moment | Motion |
| --- | --- |
| Compose → Review | Existing panel crossfade |
| Agent cards | Subtle layout / appear (already) |
| Authorize success | Soft confirmation, no confetti |
| Settlement steps | Active step pulse via LatticeLoader |
| Receipt | Settle confirmation only |

Avoid: continuous waves behind dense financial UI after Compose; fake % progress.

---

## 8. Responsive plan

- Primary: 1280–1440 laptop
- `--mw-width` already phase-tuned; keep single column for Review/Receipt
- No new 3-column dashboards
- Trail wraps; no horizontal overflow on proof hashes (break/ellipsis)

---

## 9. Accessibility plan

- Status text independent of color (keep Pills + words)
- Focus rings already on `.mw`; verify sheet / CTAs
- Semantic `h2`/`h3` per stage
- Blocker regions: `role="alert"` / `status` with category labels
- Reduced motion: no blur/scale on stage if reduced

---

## 10. Copy changes (summary)

- Compose: “What do you want your agents to do?”
- Drafting: Interpreting mandate… / Checking limits… / Ready to review
- Active: Mandate active + “Agents can act only within the authority you approved.”
- Authorize support: “Your wallet signs this authority. Agents cannot exceed it.”
- Receipt CTA: Start new mandate; demote firewall / room
- Blocked: “Mandate stopped this before execution.”
- Abstain: “Capital remains available.”
- Held: Execution held · broadcasts 0 · Check settlement status

---

## 11. Component simplification

- Soft progress cue in bar status (Define → Review → Authorize → Live → Receipt) without rigid wizard
- Receipt: semantic block first, proof second, technical details collapsed
- Review issue categories: Needs input / Not supported / Refused (policy unchanged)
- Optional compact authority map under Mandate Active (one authority → five agents)

---

## 12. Visual-state language

| State | Tone | Text |
| --- | --- | --- |
| PROPOSED | neutral | Proposed |
| AUTHORIZED | good | Authorized |
| BLOCKED | bad | Blocked |
| ABSTAINED | neutral | No action |
| SETTLED | good | Settled |
| HELD | warn | Execution held |
| Needs input | warn | Needs your input |
| Not supported | warn | Not supported |
| Refused | bad | Refused |

---

## 13. Non-goals

Protocol redesign; new agent capabilities; settlement architecture changes;
weakening `canAuthorize` / `REVIEW_BLOCKED` / draftKey; contract edits;
broadcasts; fake evidence; screenshot binaries.

---

## 14. Testing

Semantic string/structure tests in `apps/web/tests/*`:

- Compose / Review / Plan / Active / Blocked / Abstain / Receipt hierarchy
- No operator / spine language in primary UI strings
- MDUSD → MDEMO direction; fixture qualification present
- Start new mandate / no primary “Run again” after settled
- C2.1 Review blockers and trusted-field lock preserved
- Regression: authoring issue-policy and settlement helpers unchanged

---

## 15. Manual acceptance

Flows A–I from the C2.2 milestone (Stock $800; dynamic; hybrid; needs
selection; unsupported; dangerous 0x; blocked; held restore; settled
restore). Prefer stop-before-send for live broadcast. Record viewport,
console cleanliness, and known visual limits in `c2-2-validation.md`.

---

## Implementation sketch

| Area | Touch |
| --- | --- |
| Compose / draft | `stage-compose.tsx` |
| Review / authorize | `stage-configure.tsx`, `authority-review.ts`, CSS |
| Plan | `stage-planning.tsx` |
| Active / agents | `stage-agents.tsx` |
| Settlement / receipt | `stage-outcome.tsx` |
| Shell / trail / copy | `live-lab.tsx`, `live-workspace.css` |
| Tests | `apps/web/tests/c2-2-*.test.ts` + experience updates |
