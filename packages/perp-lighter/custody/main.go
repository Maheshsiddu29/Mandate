// Command lighter-custody is the Venue Signer's key-custody process for
// Lighter (Mandate Phase 7E.1).
//
// It is the only component that ever holds the Lighter API private key. It
// uses the official lighter-go SDK (github.com/elliottech/lighter-go v1.0.10,
// commit 9d38261d1a4cc5c7211b383ba07a4d6e41604708) for every cryptographic
// step — the transaction hash and the Schnorr signature — and adds only
// restrictions:
//
//   - two transaction shapes only: an L2 create-order (LIMIT or MARKET, no
//     trigger, no integrator) and an L2 cancel-order. Withdraw, transfer,
//     pool, stake, sub-account, API-key, leverage, margin and account-config
//     transactions are refused before the key is touched;
//   - one account index, one API key index and one chain id, fixed at start;
//   - `hash` never touches the key: the Mandate issuer computes the exact
//     transaction hash first and commits ADMIT_ATTEMPT to the ledger before
//     asking for `sign`;
//   - `sign` recomputes the hash from the transaction it is given and refuses
//     unless it equals the committed hash the caller names;
//   - a durable per-slot journal: a nonce slot is signed for at most one
//     transaction hash, ever. Re-signing the identical transaction is allowed
//     (it is the same artifact); any other transaction for that slot is
//     refused. The journal line is fsynced before the signature is returned.
//
// Protocol: one JSON request per line on stdin, one JSON response per line
// on stdout. There is no generic "sign these bytes" operation, and the key
// is never written to stdout, stderr or the journal.
//
// Configuration (environment, read once at start):
//
//	LIGHTER_CUSTODY_KEY_FILE       file holding the 40-byte private key as hex (mode 0600)
//	LIGHTER_CUSTODY_CHAIN_ID       Lighter L2 chain id (300 testnet)
//	LIGHTER_CUSTODY_ACCOUNT_INDEX  the dedicated sub-account
//	LIGHTER_CUSTODY_API_KEY_INDEX  the signer's API key index
//	LIGHTER_CUSTODY_JOURNAL        path of the per-slot journal file
//
// `lighter-custody keygen <file>` writes a fresh key to <file> (mode 0600)
// and prints only the public key.
package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/elliottech/lighter-go/client"
	"github.com/elliottech/lighter-go/signer"
	"github.com/elliottech/lighter-go/types/txtypes"
	p2 "github.com/elliottech/poseidon_crypto/hash/poseidon2_goldilocks_plonky2"
)

// Tx is the only transaction description custody accepts.
type Tx struct {
	Type              string `json:"type"` // CREATE_ORDER | CANCEL_ORDER
	ChainID           uint32 `json:"chainId"`
	AccountIndex      int64  `json:"accountIndex"`
	APIKeyIndex       uint8  `json:"apiKeyIndex"`
	MarketIndex       int16  `json:"marketIndex"`
	ClientOrderIndex  int64  `json:"clientOrderIndex"`
	BaseAmount        int64  `json:"baseAmount"`
	Price             uint32 `json:"price"`
	IsAsk             uint8  `json:"isAsk"`
	OrderType         uint8  `json:"orderType"`
	TimeInForce       uint8  `json:"timeInForce"`
	ReduceOnly        uint8  `json:"reduceOnly"`
	OrderExpiry       int64  `json:"orderExpiry"`
	CancelIndex       int64  `json:"cancelIndex"`
	ExpiredAt         int64  `json:"expiredAt"`
	Nonce             int64  `json:"nonce"`
	SelfTradeBehavior int64  `json:"selfTradeBehavior"`
	SelfTradeEquality int64  `json:"selfTradeEquality"`
}

type request struct {
	Op           string `json:"op"`
	Tx           *Tx    `json:"tx,omitempty"`
	ExpectedHash string `json:"expectedHash,omitempty"`
	Attempt      string `json:"attempt,omitempty"`
}

type response struct {
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
	Hash      string `json:"hash,omitempty"`
	TxType    uint8  `json:"txType,omitempty"`
	TxInfo    string `json:"txInfo,omitempty"`
	PublicKey string `json:"publicKey,omitempty"`
}

type config struct {
	chainID      uint32
	accountIndex int64
	apiKeyIndex  uint8
	journal      string
}

type custody struct {
	cfg  config
	key  signer.KeyManager
	mu   sync.Mutex
	slot map[int64]string // nonce -> the one hash ever signed for it
}

var errForbidden = errors.New("TX_TYPE_FORBIDDEN")

func attributes(tx *Tx) txtypes.L2TxAttributes {
	attrs := txtypes.L2TxAttributes{}
	if tx.SelfTradeBehavior != 0 {
		attrs[txtypes.AttributeTypeSelfTradeBehaviorMode] = tx.SelfTradeBehavior
	}
	if tx.SelfTradeEquality != 0 {
		attrs[txtypes.AttributeTypeSelfTradeEqualityMode] = tx.SelfTradeEquality
	}
	return attrs
}

// build turns an accepted description into the SDK's transaction, validated by the SDK.
func (c *custody) build(tx *Tx) (txtypes.TxInfo, uint8, error) {
	if tx == nil {
		return nil, 0, errors.New("TX_MISSING")
	}
	if tx.ChainID != c.cfg.chainID || tx.AccountIndex != c.cfg.accountIndex || tx.APIKeyIndex != c.cfg.apiKeyIndex {
		return nil, 0, errors.New("TX_BINDING_MISMATCH")
	}
	switch tx.Type {
	case "CREATE_ORDER":
		if tx.OrderType != txtypes.LimitOrder && tx.OrderType != txtypes.MarketOrder {
			return nil, 0, errForbidden
		}
		info := &txtypes.L2CreateOrderTxInfo{
			AccountIndex: tx.AccountIndex,
			ApiKeyIndex:  tx.APIKeyIndex,
			OrderInfo: &txtypes.OrderInfo{
				MarketIndex:      tx.MarketIndex,
				ClientOrderIndex: tx.ClientOrderIndex,
				BaseAmount:       tx.BaseAmount,
				Price:            tx.Price,
				IsAsk:            tx.IsAsk,
				Type:             tx.OrderType,
				TimeInForce:      tx.TimeInForce,
				ReduceOnly:       tx.ReduceOnly,
				TriggerPrice:     txtypes.NilOrderTriggerPrice,
				OrderExpiry:      tx.OrderExpiry,
			},
			ExpiredAt:      tx.ExpiredAt,
			Nonce:          tx.Nonce,
			L2TxAttributes: attributes(tx),
		}
		if err := info.Validate(); err != nil {
			return nil, 0, fmt.Errorf("TX_INVALID: %w", err)
		}
		return info, txtypes.TxTypeL2CreateOrder, nil
	case "CANCEL_ORDER":
		info := &txtypes.L2CancelOrderTxInfo{
			AccountIndex: tx.AccountIndex,
			ApiKeyIndex:  tx.APIKeyIndex,
			MarketIndex:  tx.MarketIndex,
			Index:        tx.CancelIndex,
			ExpiredAt:    tx.ExpiredAt,
			Nonce:        tx.Nonce,
		}
		if err := info.Validate(); err != nil {
			return nil, 0, fmt.Errorf("TX_INVALID: %w", err)
		}
		return info, txtypes.TxTypeL2CancelOrder, nil
	default:
		return nil, 0, errForbidden
	}
}

type hasher interface {
	Hash(lighterChainId uint32) ([]byte, error)
}

func (c *custody) hash(tx *Tx) (string, []byte, txtypes.TxInfo, uint8, error) {
	info, txType, err := c.build(tx)
	if err != nil {
		return "", nil, nil, 0, err
	}
	h, ok := info.(hasher)
	if !ok {
		return "", nil, nil, 0, errForbidden
	}
	msg, err := h.Hash(c.cfg.chainID)
	if err != nil {
		return "", nil, nil, 0, fmt.Errorf("HASH_FAILED: %w", err)
	}
	return hex.EncodeToString(msg), msg, info, txType, nil
}

func (c *custody) recordSlot(nonce int64, hash string) error {
	if prior, ok := c.slot[nonce]; ok {
		if prior != hash {
			return errors.New("SLOT_ALREADY_SIGNED")
		}
		return nil
	}
	f, err := os.OpenFile(c.cfg.journal, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("JOURNAL_UNAVAILABLE: %w", err)
	}
	defer f.Close()
	if _, err := fmt.Fprintf(f, "%d %s\n", nonce, hash); err != nil {
		return fmt.Errorf("JOURNAL_WRITE_FAILED: %w", err)
	}
	if err := f.Sync(); err != nil {
		return fmt.Errorf("JOURNAL_SYNC_FAILED: %w", err)
	}
	c.slot[nonce] = hash
	return nil
}

func (c *custody) handle(r request) response {
	switch r.Op {
	case "publicKey":
		pk := c.key.PubKeyBytes()
		return response{OK: true, PublicKey: hex.EncodeToString(pk[:])}
	case "hash":
		h, _, _, txType, err := c.hash(r.Tx)
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{OK: true, Hash: h, TxType: txType}
	case "sign":
		h, msg, info, txType, err := c.hash(r.Tx)
		if err != nil {
			return response{Error: err.Error()}
		}
		if r.ExpectedHash == "" || !strings.EqualFold(r.ExpectedHash, h) {
			return response{Error: "HASH_NOT_COMMITTED"}
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if err := c.recordSlot(r.Tx.Nonce, h); err != nil {
			return response{Error: err.Error()}
		}
		sig, err := c.key.Sign(msg, p2.NewPoseidon2())
		if err != nil {
			return response{Error: "SIGN_FAILED"}
		}
		switch t := info.(type) {
		case *txtypes.L2CreateOrderTxInfo:
			t.Sig, t.SignedHash = sig, h
		case *txtypes.L2CancelOrderTxInfo:
			t.Sig, t.SignedHash = sig, h
		}
		out, err := info.GetTxInfo()
		if err != nil {
			return response{Error: "SERIALIZE_FAILED"}
		}
		return response{OK: true, Hash: h, TxType: txType, TxInfo: out}
	default:
		return response{Error: "OP_FORBIDDEN"}
	}
}

func mustEnv(name string) string {
	v := os.Getenv(name)
	if v == "" {
		fmt.Fprintf(os.Stderr, "lighter-custody: %s is required\n", name)
		os.Exit(2)
	}
	return v
}

func loadJournal(path string) map[int64]string {
	out := map[int64]string{}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return out
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "lighter-custody: journal unreadable")
		os.Exit(2)
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		parts := strings.Fields(s.Text())
		if len(parts) != 2 {
			fmt.Fprintln(os.Stderr, "lighter-custody: journal corrupt")
			os.Exit(2)
		}
		n, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			fmt.Fprintln(os.Stderr, "lighter-custody: journal corrupt")
			os.Exit(2)
		}
		if prior, ok := out[n]; ok && prior != parts[1] {
			fmt.Fprintln(os.Stderr, "lighter-custody: journal holds two hashes for one slot")
			os.Exit(2)
		}
		out[n] = parts[1]
	}
	return out
}

func keygen(path string) {
	priv, pub, err := client.GenerateAPIKey()
	if err != nil {
		fmt.Fprintln(os.Stderr, "lighter-custody: key generation failed")
		os.Exit(2)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, "lighter-custody: cannot create key file (it must not exist)")
		os.Exit(2)
	}
	if _, err := f.WriteString(strings.TrimPrefix(priv, "0x") + "\n"); err != nil {
		os.Exit(2)
	}
	if err := f.Sync(); err != nil {
		os.Exit(2)
	}
	f.Close()
	fmt.Println(strings.TrimPrefix(pub, "0x"))
}

func main() {
	if len(os.Args) == 3 && os.Args[1] == "keygen" {
		keygen(os.Args[2])
		return
	}
	raw, err := os.ReadFile(mustEnv("LIGHTER_CUSTODY_KEY_FILE"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "lighter-custody: key file unreadable")
		os.Exit(2)
	}
	keyBytes, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(string(raw)), "0x"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "lighter-custody: key file malformed")
		os.Exit(2)
	}
	key, err := signer.NewKeyManager(keyBytes)
	for i := range keyBytes {
		keyBytes[i] = 0
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "lighter-custody: key invalid")
		os.Exit(2)
	}
	chain, err1 := strconv.ParseUint(mustEnv("LIGHTER_CUSTODY_CHAIN_ID"), 10, 32)
	account, err2 := strconv.ParseInt(mustEnv("LIGHTER_CUSTODY_ACCOUNT_INDEX"), 10, 64)
	apiKey, err3 := strconv.ParseUint(mustEnv("LIGHTER_CUSTODY_API_KEY_INDEX"), 10, 8)
	if err1 != nil || err2 != nil || err3 != nil {
		fmt.Fprintln(os.Stderr, "lighter-custody: configuration malformed")
		os.Exit(2)
	}
	journal := mustEnv("LIGHTER_CUSTODY_JOURNAL")
	c := &custody{cfg: config{chainID: uint32(chain), accountIndex: account, apiKeyIndex: uint8(apiKey), journal: journal}, key: key, slot: loadJournal(journal)}

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64*1024), 64*1024)
	out := json.NewEncoder(os.Stdout)
	for in.Scan() {
		var r request
		if err := json.Unmarshal(in.Bytes(), &r); err != nil {
			_ = out.Encode(response{Error: "REQUEST_MALFORMED"})
			continue
		}
		_ = out.Encode(c.handle(r))
	}
}
