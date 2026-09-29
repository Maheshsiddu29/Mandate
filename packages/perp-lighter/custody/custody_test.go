package main

// Go-level custody mutants (Phase 7E.2), run by `npm run lighter:custody:check`,
// which builds a real SQLite ledger with one durable ADMIT_ATTEMPT (for tx A)
// and passes it here via LIGHTER_CUSTODY_TEST_FIXTURE. Without the fixture the
// test is skipped: `go test` alone has no ledger to verify against.
//
// Scenario: a caller asks custody to sign tx B under A's attempt (the wrong
// ledger record), and to sign A with no attempt at all.
//
//   - production (ledgerView.VerifyAdmitted) refuses both before key use;
//   - M12 trusts that the transaction is the admitted one once the attempt
//     exists (it never compares custody's own hash with the committed
//     artifact): it signs B — killed;
//   - M13 requires no attempt: it signs A with none — killed.

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/elliottech/lighter-go/client"
	"github.com/elliottech/lighter-go/signer"
)

type fixture struct {
	Ledger  string       `json:"ledger"`
	Binding Binding      `json:"binding"`
	Claim   AttemptClaim `json:"claim"`
	TxA     Tx           `json:"txA"`
	TxB     Tx           `json:"txB"`
	NowMs   int64        `json:"nowMs"`
}

func loadFixture(t *testing.T) fixture {
	path := os.Getenv("LIGHTER_CUSTODY_TEST_FIXTURE")
	if path == "" {
		t.Skip("LIGHTER_CUSTODY_TEST_FIXTURE not set (run npm run lighter:custody:check)")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func custodyWith(t *testing.T, f fixture, v verifier) *custody {
	priv, _, err := client.GenerateAPIKey()
	if err != nil {
		t.Fatal(err)
	}
	key, err := signer.NewKeyManager(mustHex(t, priv))
	if err != nil {
		t.Fatal(err)
	}
	cfg := config{chainID: f.TxA.ChainID, accountIndex: f.TxA.AccountIndex, apiKeyIndex: f.TxA.APIKeyIndex, journal: filepath.Join(t.TempDir(), "journal")}
	return &custody{cfg: cfg, key: key, slot: map[int64]string{}, verify: v}
}

func mustHex(t *testing.T, s string) []byte {
	b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The mutants, each one weakening VerifyAdmitted in exactly one way.
func trustCaller(l *ledgerView) verifier {
	return func(claim AttemptClaim, tx *Tx, hash []byte, cfg config, now time.Time) error {
		var principal string
		if err := l.db.QueryRow(`SELECT principal FROM ledger_attempt_index WHERE attempt = ?`, claim.Attempt).Scan(&principal); err != nil {
			return errors.New("ATTEMPT_NOT_ADMITTED")
		}
		return nil // M12: the attempt exists, so whatever was asked for must be it
	}
}

func noAttemptRequired(l *ledgerView) verifier {
	return func(AttemptClaim, *Tx, []byte, config, time.Time) error { return nil } // M13
}

type outcome struct{ wrongRecordSigned, missingAttemptSigned bool }

func run(t *testing.T, f fixture, mk func(*ledgerView) verifier) outcome {
	l, err := openLedger(f.Ledger, f.Binding)
	if err != nil {
		t.Fatal(err)
	}
	defer l.db.Close()
	now := time.UnixMilli(f.NowMs)
	v := mk(l)
	// A fresh custody (and slot journal) per request: each request is judged by the verifier alone.
	fresh := func() *custody {
		return custodyWith(t, f, func(claim AttemptClaim, tx *Tx, hash []byte, cfg config, _ time.Time) error {
			return v(claim, tx, hash, cfg, now)
		})
	}
	txB := f.TxB
	wrong := fresh().handle(request{Op: "sign", Tx: &txB, Claim: &f.Claim})
	txA := f.TxA
	// M13's weakening is "an absent attempt is acceptable": the request still carries a claim, with no attempt the ledger holds.
	absent := AttemptClaim{Attempt: "0x" + strings.Repeat("7", 64), Reservation: f.Claim.Reservation, Generation: f.Claim.Generation, Action: f.Claim.Action}
	missing := fresh().handle(request{Op: "sign", Tx: &txA, Claim: &absent})
	return outcome{wrongRecordSigned: wrong.OK, missingAttemptSigned: missing.OK}
}

func TestProductionRefusesBeforeKeyUse(t *testing.T) {
	f := loadFixture(t)
	if got := run(t, f, func(l *ledgerView) verifier { return l.VerifyAdmitted }); got.wrongRecordSigned || got.missingAttemptSigned {
		t.Fatalf("production signed: %+v", got)
	}
	// And the admitted transaction itself is signable.
	l, err := openLedger(f.Ledger, f.Binding)
	if err != nil {
		t.Fatal(err)
	}
	defer l.db.Close()
	now := time.UnixMilli(f.NowMs)
	c := custodyWith(t, f, func(claim AttemptClaim, tx *Tx, hash []byte, cfg config, _ time.Time) error {
		return l.VerifyAdmitted(claim, tx, hash, cfg, now)
	})
	txA := f.TxA
	if r := c.handle(request{Op: "sign", Tx: &txA, Claim: &f.Claim}); !r.OK {
		t.Fatalf("production refused the admitted transaction: %s", r.Error)
	}
	if r := c.handle(request{Op: "sign", Tx: &txA}); r.OK || r.Error != "ATTEMPT_ID_MISSING" {
		t.Fatalf("no claim: %+v", r)
	}
}

func TestMutantM12TrustCallerKilled(t *testing.T) {
	if got := run(t, loadFixture(t), trustCaller); !got.wrongRecordSigned {
		t.Fatalf("M12 survived: %+v", got)
	}
}

func TestMutantM13NoAttemptRequiredKilled(t *testing.T) {
	if got := run(t, loadFixture(t), noAttemptRequired); !got.missingAttemptSigned {
		t.Fatalf("M13 survived: %+v", got)
	}
}

// The per-slot journal is defense in depth behind VerifyAdmitted (the ledger
// already admits one artifact per slot), so it is exercised with a verifier
// that admits everything: a second transaction for a signed slot is refused,
// also by a restarted custody reading the journal. Needs no fixture.
func TestSlotJournalSurvivesRestart(t *testing.T) {
	admitAll := func(AttemptClaim, *Tx, []byte, config, time.Time) error { return nil }
	f := fixture{TxA: Tx{Type: "CREATE_ORDER", ChainID: 300, AccountIndex: 281474976710600, APIKeyIndex: 5, MarketIndex: 1, ClientOrderIndex: 7, BaseAmount: 100, Price: 836250, OrderType: 0, TimeInForce: 0, ExpiredAt: 1790637000000, Nonce: 3, SelfTradeBehavior: 1}}
	c := custodyWith(t, f, admitAll)
	claim := AttemptClaim{Attempt: "0x" + strings.Repeat("1", 64)}
	a := f.TxA
	if r := c.handle(request{Op: "sign", Tx: &a, Claim: &claim}); !r.OK {
		t.Fatalf("first sign: %s", r.Error)
	}
	if r := c.handle(request{Op: "sign", Tx: &a, Claim: &claim}); !r.OK {
		t.Fatalf("identical re-sign: %s", r.Error)
	}
	b := f.TxA
	b.BaseAmount++
	if r := c.handle(request{Op: "sign", Tx: &b, Claim: &claim}); r.OK || r.Error != "SLOT_ALREADY_SIGNED" {
		t.Fatalf("second transaction for the slot: %+v", r)
	}
	restarted := &custody{cfg: c.cfg, key: c.key, slot: loadJournal(c.cfg.journal), verify: admitAll}
	if r := restarted.handle(request{Op: "sign", Tx: &b, Claim: &claim}); r.OK || r.Error != "SLOT_ALREADY_SIGNED" {
		t.Fatalf("after restart: %+v", r)
	}
}
