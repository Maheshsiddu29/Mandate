# Architecture Decision Records

Each ADR records one decision: the context that forced it, the decision taken,
and the consequences accepted. ADRs are immutable once accepted — a decision
that changes gets a new ADR that supersedes the old one, and the old one is
marked superseded rather than edited.

Format: `NNNN-kebab-case-title.md`, with `Status`, `Date`, `Context`,
`Decision`, `Consequences`.

Status values: `Proposed`, `Accepted`, `Superseded by ADR NNNN`, `Rejected`.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-mandate-authorization-architecture.md) | Mandate authorization architecture | Accepted |
| [0002](0002-canonical-mandate-encoding.md) | Canonical mandate encoding and digest | Accepted |
| [0003](0003-kernel-language-and-dependency-boundary.md) | Kernel language and dependency boundary | Accepted |

The canonical product specification remains
[docs/mandate-design.md](../mandate-design.md). ADRs record *how* a specified
thing is built, not *what* the product is.
