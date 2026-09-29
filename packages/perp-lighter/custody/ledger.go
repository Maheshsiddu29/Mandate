package main

// Independent verification of a durable ADMIT_ATTEMPT (Mandate Phase 7E.2).
//
// Custody does not believe a caller who says "Mandate admitted this". Before
// the key is used it reads the ledger's SQLite database itself — read-only —
// and verifies, from the committed batch bytes:
//
//   - the attempt exists (derived index → the batch that holds it);
//   - that batch is committed (the principal's head is at or past it) and
//     intact (keccak-256 of its bytes is its recorded head);
//   - the batch holds exactly one event, the ADMIT_ATTEMPT, for exactly the
//     attempt requested, whose id re-derives from its own fields;
//   - principal, ModuleRef, AdapterRef and venue account are the ones this
//     custody serves; reservation, generation and action are the ones the
//     request names;
//   - the committed artifact is the hash custody computes itself from the
//     transaction it is asked to sign, and the committed slot is its nonce;
//   - the attempt is still within its validity, its reservation is not
//     closed, no issuance of it is already recorded, and the module and
//     adapter are ACTIVE or RETIRING in the durable lifecycle table.
//
// The indexes it uses only locate facts; everything that decides is read from
// the batch bytes, whose digest is the ledger head. A missing, stale or forged
// index row can only make custody refuse. Custody never writes the database.

import (
	"bytes"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
	_ "github.com/mattn/go-sqlite3"
)

// Binding is what this custody process serves, fixed at start.
type Binding struct {
	Principal string `json:"principal"` // the ledger's principal key, e.g. ["ADDRESS","0x…"]
	Module    struct {
		DomainID      string `json:"domainId"`
		ModuleID      string `json:"moduleId"`
		ModuleVersion uint32 `json:"moduleVersion"`
		ModuleDigest  string `json:"moduleDigest"`
	} `json:"module"`
	Adapter struct {
		AdapterID      string `json:"adapterId"`
		AdapterVersion uint32 `json:"adapterVersion"`
		AdapterDigest  string `json:"adapterDigest"`
	} `json:"adapter"`
}

// AttemptClaim is what the signer says it wants signed: an attempt, and which reservation it believes it belongs to.
type AttemptClaim struct {
	Attempt     string `json:"attempt"`
	Reservation string `json:"reservation"`
	Generation  uint64 `json:"generation"`
	Action      string `json:"action"`
}

type moduleRef struct {
	domainID, moduleID string
	version            uint32
	digest             []byte
}

type adapterRef struct {
	id      string
	version uint32
	digest  []byte
}

type admission struct {
	attempt, reservation, action, authorization []byte
	ordinal                                     uint16
	generation                                  uint64
	module                                      moduleRef
	adapter                                     adapterRef
	accountDomain, accountLocal                 string
	accountKind                                 uint8
	artifactKind                                string
	artifactID                                  []byte
	hasSlot                                     bool
	slotScope                                   string
	slotSequence                                uint64
	validUntil                                  int64
}

type reader struct {
	b   []byte
	off int
	err error
}

func (r *reader) take(n int) []byte {
	if r.err != nil {
		return nil
	}
	if n < 0 || r.off+n > len(r.b) {
		r.err = errors.New("truncated")
		return nil
	}
	out := r.b[r.off : r.off+n]
	r.off += n
	return out
}
func (r *reader) u8() uint8 {
	b := r.take(1)
	if b == nil {
		return 0
	}
	return b[0]
}
func (r *reader) u16() uint16 {
	b := r.take(2)
	if b == nil {
		return 0
	}
	return binary.BigEndian.Uint16(b)
}
func (r *reader) u32() uint32 {
	b := r.take(4)
	if b == nil {
		return 0
	}
	return binary.BigEndian.Uint32(b)
}
func (r *reader) u64() uint64 {
	b := r.take(8)
	if b == nil {
		return 0
	}
	return binary.BigEndian.Uint64(b)
}
func (r *reader) str() string    { return string(r.take(int(r.u16()))) }
func (r *reader) digest() []byte { return append([]byte(nil), r.take(32)...) }

// The ledger's canonical encodings (kernel ByteWriter, core, ledger): big-endian integers, u16-length strings.
type writer struct{ bytes.Buffer }

func (w *writer) str(s string) {
	_ = binary.Write(&w.Buffer, binary.BigEndian, uint16(len(s)))
	w.WriteString(s)
}
func (w *writer) u16(v uint16) { _ = binary.Write(&w.Buffer, binary.BigEndian, v) }
func (w *writer) u32(v uint32) { _ = binary.Write(&w.Buffer, binary.BigEndian, v) }
func (w *writer) u64(v uint64) { _ = binary.Write(&w.Buffer, binary.BigEndian, v) }

const (
	batchTag        = "mandate-core/v1/ledger-batch"
	attemptTag      = "mandate-core/v1/attempt"
	schemaVersion   = 1
	eventAdmit      = 12
	artifactKind    = "lighter.l2-tx-hash"
	resourceAccount = 4
	lighterDomain   = "lighter-perp"
)

func readAdmission(r *reader) admission {
	var a admission
	a.attempt = r.digest()
	a.ordinal = r.u16()
	a.reservation = r.digest()
	a.generation = r.u64()
	a.action = r.digest()
	a.authorization = r.digest()
	a.module = moduleRef{domainID: r.str(), moduleID: r.str(), version: r.u32(), digest: r.digest()}
	a.adapter = adapterRef{id: r.str(), version: r.u32(), digest: r.digest()}
	a.accountDomain = r.str()
	a.accountKind = r.u8()
	a.accountLocal = r.str()
	a.artifactKind = r.str()
	a.artifactID = append([]byte(nil), r.take(int(r.u8()))...)
	if r.u8() == 1 {
		a.hasSlot = true
		a.slotScope = r.str()
		a.slotSequence = r.u64()
	}
	a.validUntil = int64(r.u64())
	r.digest() // requirements
	r.digest() // revalidation
	return a
}

// attemptID re-derives H("mandate-core/v1/attempt", reservation, generation, action, ModuleRef, AdapterRef, authorization, ordinal).
func attemptID(a admission) []byte {
	var w writer
	w.str(attemptTag)
	w.u16(schemaVersion)
	w.Write(a.reservation)
	w.u64(a.generation)
	w.Write(a.action)
	w.str(a.module.domainID)
	w.str(a.module.moduleID)
	w.u32(a.module.version)
	w.Write(a.module.digest)
	w.str(a.adapter.id)
	w.u32(a.adapter.version)
	w.Write(a.adapter.digest)
	w.Write(a.authorization)
	w.u16(a.ordinal)
	return crypto.Keccak256(w.Bytes())
}

var digestHex = regexp.MustCompile(`^0x[0-9a-f]{64}$`)

func hex32(s string) ([]byte, error) {
	if !digestHex.MatchString(s) {
		return nil, errors.New("not a digest")
	}
	return hex.DecodeString(s[2:])
}

type ledgerView struct {
	db      *sql.DB
	binding Binding
}

func openLedger(path string, binding Binding) (*ledgerView, error) {
	// Read-only: custody can verify the ledger but never change it.
	db, err := sql.Open("sqlite3", fmt.Sprintf("file:%s?mode=ro&_busy_timeout=5000", path))
	if err != nil {
		return nil, err
	}
	return &ledgerView{db: db, binding: binding}, nil
}

// VerifyAdmitted is the check that must pass before the key is used. `hash` is custody's own hash of `tx`.
func (l *ledgerView) VerifyAdmitted(claim AttemptClaim, tx *Tx, hash []byte, cfg config, now time.Time) error {
	attempt, err := hex32(claim.Attempt)
	if err != nil {
		return errors.New("ATTEMPT_ID_MISSING")
	}
	txn, err := l.db.Begin() // one consistent read of committed state
	if err != nil {
		return errors.New("LEDGER_UNAVAILABLE")
	}
	defer txn.Rollback()

	var principal string
	var version int64
	if err := txn.QueryRow(`SELECT principal, version FROM ledger_attempt_index WHERE attempt = ?`, claim.Attempt).Scan(&principal, &version); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("ATTEMPT_NOT_ADMITTED")
		}
		return errors.New("LEDGER_UNAVAILABLE")
	}
	if principal != l.binding.Principal {
		return errors.New("ATTEMPT_OTHER_PRINCIPAL")
	}
	var headVersion int64
	if err := txn.QueryRow(`SELECT version FROM ledger_heads WHERE principal = ?`, principal).Scan(&headVersion); err != nil || headVersion < version {
		return errors.New("ATTEMPT_NOT_COMMITTED")
	}
	var encoded []byte
	var head, previous string
	if err := txn.QueryRow(`SELECT encoded, head, previous_head FROM ledger_batches WHERE principal = ? AND version = ?`, principal, version).Scan(&encoded, &head, &previous); err != nil {
		return errors.New("ATTEMPT_NOT_COMMITTED")
	}
	if "0x"+hex.EncodeToString(crypto.Keccak256(encoded)) != head {
		return errors.New("LEDGER_BATCH_CORRUPT")
	}

	// The batch: tag, schema, principal, version, previous head, exactly one event — the admission.
	r := &reader{b: encoded}
	var party []string
	_ = json.Unmarshal([]byte(principal), &party)
	if r.str() != batchTag || r.u16() != schemaVersion || len(party) != 2 || r.str() != party[0] || r.str() != party[1] || int64(r.u64()) != version {
		return errors.New("LEDGER_BATCH_MISMATCH")
	}
	if "0x"+hex.EncodeToString(r.digest()) != previous || r.u16() != 1 || r.u8() != eventAdmit {
		return errors.New("LEDGER_BATCH_MISMATCH")
	}
	r.u64() // the event's evaluation time
	a := readAdmission(r)
	if r.err != nil || r.off != len(encoded) {
		return errors.New("LEDGER_BATCH_MALFORMED")
	}
	if !bytes.Equal(a.attempt, attempt) || !bytes.Equal(attemptID(a), attempt) {
		return errors.New("ATTEMPT_ID_MISMATCH")
	}

	// Who it is for, and which reservation.
	m := l.binding.Module
	if a.module.domainID != m.DomainID || a.module.moduleID != m.ModuleID || a.module.version != m.ModuleVersion || "0x"+hex.EncodeToString(a.module.digest) != m.ModuleDigest {
		return errors.New("MODULE_NOT_SERVED")
	}
	ad := l.binding.Adapter
	if a.adapter.id != ad.AdapterID || a.adapter.version != ad.AdapterVersion || "0x"+hex.EncodeToString(a.adapter.digest) != ad.AdapterDigest {
		return errors.New("ADAPTER_NOT_SERVED")
	}
	if "0x"+hex.EncodeToString(a.reservation) != claim.Reservation || a.generation != claim.Generation || "0x"+hex.EncodeToString(a.action) != claim.Action {
		return errors.New("RESERVATION_MISMATCH")
	}
	if a.accountDomain != lighterDomain || a.accountKind != resourceAccount || a.accountLocal != fmt.Sprintf("lighter:%d:account:%d", cfg.chainID, cfg.accountIndex) {
		return errors.New("ACCOUNT_MISMATCH")
	}

	// The exact artifact and slot.
	if a.artifactKind != artifactKind || !bytes.Equal(a.artifactID, hash) {
		return errors.New("ARTIFACT_NOT_ADMITTED")
	}
	if !a.hasSlot || a.slotScope != fmt.Sprintf("lighter:%d:account:%d:key:%d", cfg.chainID, cfg.accountIndex, cfg.apiKeyIndex) || int64(a.slotSequence) != tx.Nonce {
		return errors.New("SLOT_MISMATCH")
	}
	if now.Unix() >= a.validUntil || tx.ExpiredAt > a.validUntil*1000 {
		return errors.New("ATTEMPT_EXPIRED")
	}

	// Nothing since admission forbids issuance.
	var closed int
	if err := txn.QueryRow(`SELECT COUNT(*) FROM ledger_closed_reservations WHERE reservation = ?`, claim.Reservation).Scan(&closed); err != nil {
		return errors.New("LEDGER_UNAVAILABLE")
	}
	if closed != 0 {
		return errors.New("RESERVATION_CLOSED")
	}
	var issued int
	if err := txn.QueryRow(`SELECT COUNT(*) FROM issuance_journal WHERE attempt = ?`, claim.Attempt).Scan(&issued); err != nil {
		return errors.New("JOURNAL_UNAVAILABLE")
	}
	if issued != 0 {
		return errors.New("ATTEMPT_ALREADY_ISSUED")
	}
	for _, lc := range []struct {
		kind, name string
		version    uint32
		digest     string
	}{
		{"MODULE", m.ModuleID, m.ModuleVersion, m.ModuleDigest},
		{"ADAPTER", ad.AdapterID, ad.AdapterVersion, ad.AdapterDigest},
	} {
		var status, digest string
		if err := txn.QueryRow(`SELECT status, digest FROM lifecycle WHERE kind = ? AND name = ? AND version = ?`, lc.kind, lc.name, lc.version).Scan(&status, &digest); err != nil {
			return errors.New(lc.kind + "_LIFECYCLE_UNKNOWN")
		}
		if digest != lc.digest {
			return errors.New(lc.kind + "_LIFECYCLE_OTHER_DIGEST")
		}
		if status != "ACTIVE" && status != "RETIRING" {
			return errors.New(lc.kind + "_" + strings.ToUpper(status))
		}
	}
	return nil
}
