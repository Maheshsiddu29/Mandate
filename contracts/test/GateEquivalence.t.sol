// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";

import {MandateExecutionGate} from "../src/MandateExecutionGate.sol";
import {Candidate, ExecutionTerms, Mandate} from "../src/MandateTypes.sol";
import {MockERC20} from "./mocks/MockTokens.sol";
// Imported so the artifact `vm.getCode(REFERENCE_GATE)` loads is always compiled.
import {ReferenceMandateExecutionGate} from "./reference/ReferenceMandateExecutionGate.sol";
import {CorpusWorld, DifferentialTest} from "./Differential.t.sol";

string constant OPTIMIZED_GATE = "MandateExecutionGate.sol:MandateExecutionGate";
string constant REFERENCE_GATE = "ReferenceMandateExecutionGate.sol:ReferenceMandateExecutionGate";

/// @dev Both implementations expose the same interface; this pins that at compile time.
function _referenceGate() pure returns (ReferenceMandateExecutionGate) {
    return ReferenceMandateExecutionGate(address(0));
}

/// @notice The whole shared corpus, with the TypeScript expectations, replayed
/// against the pre-optimization gate: the reference still meets every
/// expectation the production gate meets (Phase 6R.2B).
contract ReferenceGateDifferentialTest is DifferentialTest {
    function _gateArtifact() internal pure override returns (string memory) {
        return REFERENCE_GATE;
    }
}

/// @notice Before/after semantic differential (Phase 6R.2B): every attempt runs
/// on the production gate and on the pre-optimization gate
/// (`reference/ReferenceMandateExecutionGate.sol`), each constructed at the same
/// address from the same state, so signatures, created adapters and events are
/// comparable byte for byte. An outcome is: success or revert, the complete
/// return or revert data (so the selector and every argument), every log of the
/// transaction (the gate's `MandateExecuted` — both digests, the commitment,
/// agent, adapter, tokens, side, debit, credit — and every token `Transfer` and
/// `Approval`), the replay record `executionCommitmentOf(mandateDigest)`, and
/// the principal's, the sink's and the gate's balances of every token.
///
/// Optimization must be externally invisible: the expected mismatch count is zero.
contract GateEquivalenceTest is CorpusWorld {
    uint256 internal constant AGENT_KEY = 0x8da4ef21b864d2cc526dbdb2a120bd2874c36c9d0a1fb7f8c63d7f7a8b41de8f;
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    struct Outcome {
        bool ok;
        bytes data;
        bytes32 logs;
        bytes32 state;
    }

    /// @dev ABI blobs of corpus vectors with a settling attempt: the fuzzer's seeds.
    bytes[] internal settlingVectors;

    function setUp() public override {
        _world();
        bytes[] memory blobs = _section(".vectors");
        for (uint256 i = 0; i < blobs.length; ++i) {
            GateVector memory v = abi.decode(blobs[i], (GateVector));
            if (_settlingAttempt(v) != type(uint256).max) settlingVectors.push(blobs[i]);
        }
    }

    // ------------------------------------------------------------------
    // Every corpus attempt, both gates
    // ------------------------------------------------------------------

    function test_equivalence_everyCorpusAttempt() public {
        vm.pauseGasMetering(); // two full corpus replays; nothing here measures gas
        bytes[] memory vectors = _section(".vectors");
        bytes[] memory authority = _section(".authorityVectors");
        uint256 start = vm.snapshotState();
        Outcome[] memory optimized = _replayAll(OPTIMIZED_GATE, vectors, authority);
        vm.revertToState(start);
        Outcome[] memory reference_ = _replayAll(REFERENCE_GATE, vectors, authority);

        assertEq(optimized.length, reference_.length, "attempt count");
        uint256 settled;
        for (uint256 i = 0; i < optimized.length; ++i) {
            _assertSame(optimized[i], reference_[i], string.concat("corpus attempt #", vm.toString(i)));
            if (optimized[i].ok) ++settled;
        }
        emit log_named_uint("EQUIVALENCE vectors", vectors.length + authority.length);
        emit log_named_uint("EQUIVALENCE attempts", optimized.length);
        emit log_named_uint("EQUIVALENCE settled on both", settled);
        emit log_named_uint("EQUIVALENCE reverted identically on both", optimized.length - settled);
        emit log_named_uint("EQUIVALENCE mismatches", 0);
    }

    function _replayAll(string memory artifact, bytes[] memory vectors, bytes[] memory authority)
        internal
        returns (Outcome[] memory out)
    {
        _installGate(artifact);
        out = new Outcome[](_attemptCount(vectors) + _attemptCount(authority));
        uint256 k;
        for (uint256 pass = 0; pass < 2; ++pass) {
            bytes[] memory blobs = pass == 0 ? vectors : authority;
            for (uint256 i = 0; i < blobs.length; ++i) {
                GateVector memory v = abi.decode(blobs[i], (GateVector));
                uint256 snapshot = vm.snapshotState();
                _fund(v);
                for (uint256 j = 0; j < v.attempts.length; ++j) {
                    out[k++] = _run(v.attempts[j]);
                }
                vm.revertToState(snapshot);
            }
        }
    }

    function _attemptCount(bytes[] memory blobs) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < blobs.length; ++i) {
            n += abi.decode(blobs[i], (GateVector)).attempts.length;
        }
    }

    // ------------------------------------------------------------------
    // Mutated attempts, both gates
    // ------------------------------------------------------------------

    /// A settling corpus attempt, mutated one to three times — an identifier
    /// byte or length, a set's order or membership, a numeric field, a wire
    /// code, time, recipient, route data, the adapter script — then usually
    /// re-signed honestly so the mutation reaches the checks behind the
    /// signatures. It runs, then the unmutated attempt, then the mutated one
    /// again, so replay state is compared too.
    function testFuzz_equivalence_mutatedAttempts(uint256 seed) public {
        vm.pauseGasMetering(); // four gate constructions per run
        _mutatedCase(seed);
    }

    /// The same, deterministically, reporting what the mutations reached: how
    /// many settled and how many distinct refusals, so the fuzzer is shown not
    /// to be vacuous (every mutation refused at the signature, say).
    function test_equivalence_mutationCampaign() public {
        vm.pauseGasMetering(); // four gate constructions per case
        uint256 cases = vm.envOr("GATE_MUTATION_CASES", uint256(400));
        bytes4[64] memory selectors;
        uint256 distinct;
        uint256 settled;
        uint256 steps;
        for (uint256 i = 0; i < cases; ++i) {
            // Each case's allocations are released afterwards; only the counters live on.
            uint256 fmp;
            assembly ("memory-safe") {
                fmp := mload(0x40)
            }
            Outcome[3] memory o = _mutatedCase(uint256(keccak256(abi.encode("mutation campaign", i))));
            for (uint256 k = 0; k < 3; ++k) {
                ++steps;
                if (o[k].ok) {
                    ++settled;
                    continue;
                }
                bytes4 sel = bytes4(o[k].data);
                bool seen;
                for (uint256 d = 0; d < distinct; ++d) {
                    if (selectors[d] == sel) seen = true;
                }
                if (!seen && distinct < selectors.length) selectors[distinct++] = sel;
            }
            assembly ("memory-safe") {
                mstore(0x40, fmp)
            }
        }
        emit log_named_uint("MUTATION cases", cases);
        emit log_named_uint("MUTATION attempts compared (3 per case)", steps);
        emit log_named_uint("MUTATION settled on both", settled);
        emit log_named_uint("MUTATION distinct revert selectors on both", distinct);
        emit log_named_uint("MUTATION mismatches", 0);
        if (cases >= 100) {
            assertGt(settled, 0, "no mutated sequence settled");
            assertGt(distinct, 15, "mutations reach too few distinct refusals");
        }
    }

    /// @dev Mutates a settling corpus attempt, runs the three-step sequence on
    /// both gates, requires identical outcomes, returns the production ones.
    function _mutatedCase(uint256 seed) internal returns (Outcome[3] memory optimized) {
        GateVector memory v = abi.decode(settlingVectors[seed % settlingVectors.length], (GateVector));
        Attempt memory original = v.attempts[_settlingAttempt(v)];
        Attempt memory mutated = abi.decode(abi.encode(original), (Attempt));
        uint256 count = 1 + (seed >> 8) % 3;
        for (uint256 i = 0; i < count; ++i) {
            _mutate(mutated, uint256(keccak256(abi.encode(seed, i))));
        }
        if ((seed >> 16) % 8 != 0) _sign(mutated);

        uint256 start = vm.snapshotState();
        optimized = _sequence(OPTIMIZED_GATE, v, mutated, original);
        vm.revertToState(start);
        Outcome[3] memory reference_ = _sequence(REFERENCE_GATE, v, mutated, original);
        vm.revertToState(start);
        for (uint256 i = 0; i < 3; ++i) {
            _assertSame(optimized[i], reference_[i], string.concat("mutated sequence step ", vm.toString(i)));
        }
    }

    function _sequence(string memory artifact, GateVector memory v, Attempt memory mutated, Attempt memory original)
        internal
        returns (Outcome[3] memory out)
    {
        _installGate(artifact);
        _fund(v);
        out[0] = _run(mutated);
        out[1] = _run(original);
        out[2] = _run(mutated);
    }

    function _settlingAttempt(GateVector memory v) internal pure returns (uint256) {
        for (uint256 j = 0; j < v.attempts.length; ++j) {
            if (v.attempts[j].expected.settled) return j;
        }
        return type(uint256).max;
    }

    /// @dev The identifier fields an agent or principal controls, by index.
    uint256 internal constant IDENTIFIER_FIELDS = 21;

    function _mutate(Attempt memory a, uint256 r) internal view {
        uint256 kind = r % 9;
        r >>= 8;
        if (kind <= 1) {
            // Corrupt one byte of an identifier, often at a word boundary or an end.
            bytes memory b = _identifier(a, r % IDENTIFIER_FIELDS);
            if (b.length == 0) return;
            uint256[7] memory edges = [uint256(0), b.length - 1, 31, 32, 33, 63, 64];
            uint256 pos = (r >> 8) % 2 == 0 ? edges[(r >> 16) % 7] : (r >> 16) % b.length;
            if (pos >= b.length) pos = b.length - 1;
            b[pos] = bytes1(uint8(r >> 32));
        } else if (kind == 2) {
            // Lengthen or shorten an identifier by one byte.
            uint256 field = r % IDENTIFIER_FIELDS;
            bytes memory b = _identifier(a, field);
            bytes memory changed;
            if ((r >> 8) % 2 == 0 || b.length == 0) {
                changed = bytes.concat(b, bytes1(uint8(r >> 16)));
            } else {
                changed = new bytes(b.length - 1);
                for (uint256 i = 0; i < changed.length; ++i) {
                    changed[i] = b[i];
                }
            }
            _setIdentifier(a, field, string(changed));
        } else if (kind == 3) {
            _mutateSet(a, r);
        } else if (kind == 4) {
            _mutateNumber(a, r);
        } else if (kind == 5) {
            uint256 which = r % 6;
            uint8 delta = uint8(1 + (r >> 8) % 2);
            if (which == 0) a.mandate.side ^= 3; // BUY <-> SELL
            else if (which == 1) a.candidate.side ^= 3;
            else if (which == 2) a.mandate.version += delta;
            else if (which == 3) a.candidate.version += delta;
            else if (which == 4) a.mandate.syntheticPolicy ^= 3;
            else a.mandate.haltPolicy += delta;
        } else if (kind == 6) {
            // Time: across notBefore, expiry and the deadline.
            int256 shift = int256((r >> 8) % 7_200_000) - 3_600_000;
            a.timestamp = uint256(int256(a.timestamp) + shift);
            if (r % 3 == 0) a.terms.deadline = uint64(a.timestamp - 1);
        } else if (kind == 7) {
            if (r % 3 == 0) a.terms.recipient = SINK;
            else if (r % 3 == 1) a.terms.executionData = abi.encodePacked(r);
            else a.candidate.agent = principal;
        } else {
            // The adapter misbehaves: another mode, or one atom more or less.
            if (r % 2 == 0) a.script.mode = uint8((r >> 8) % 3);
            else if (r % 4 == 1) a.script.deliver += 1;
            else a.script.deliver -= a.script.deliver == 0 ? 0 : 1;
        }
    }

    function _identifier(Attempt memory a, uint256 field) internal pure returns (bytes memory) {
        Mandate memory m = a.mandate;
        Candidate memory c = a.candidate;
        if (field == 0) return bytes(m.canonicalAsset.assetClass);
        if (field == 1) return bytes(m.canonicalAsset.idScheme);
        if (field == 2) return bytes(m.canonicalAsset.value);
        if (field == 3) return bytes(m.maxNotional.unit);
        if (field == 4) return bytes(m.economicLimit.unit);
        if (field == 5) return m.allowedIssuers.length == 0 ? bytes("") : bytes(m.allowedIssuers[0]);
        if (field == 6) return m.allowedChains.length == 0 ? bytes("") : bytes(m.allowedChains[0]);
        if (field == 7) return m.allowedVenues.length == 0 ? bytes("") : bytes(m.allowedVenues[0]);
        if (field == 8) return bytes(c.representationId);
        if (field == 9) return bytes(c.canonicalAsset.assetClass);
        if (field == 10) return bytes(c.canonicalAsset.idScheme);
        if (field == 11) return bytes(c.canonicalAsset.value);
        if (field == 12) return bytes(c.issuer);
        if (field == 13) return bytes(c.chain);
        if (field == 14) return bytes(c.venue);
        if (field == 15) return bytes(c.quantity.unit);
        if (field == 16) return bytes(c.executionPrice.numeratorUnit);
        if (field == 17) return bytes(c.executionPrice.denominatorUnit);
        if (field == 18) return bytes(c.notional.unit);
        if (field == 19) return bytes(c.feeTotal.unit);
        return bytes(c.evaluationStateId);
    }

    function _setIdentifier(Attempt memory a, uint256 field, string memory s) internal pure {
        Mandate memory m = a.mandate;
        Candidate memory c = a.candidate;
        if (field == 0) m.canonicalAsset.assetClass = s;
        else if (field == 1) m.canonicalAsset.idScheme = s;
        else if (field == 2) m.canonicalAsset.value = s;
        else if (field == 3) m.maxNotional.unit = s;
        else if (field == 4) m.economicLimit.unit = s;
        else if (field == 5 && m.allowedIssuers.length != 0) m.allowedIssuers[0] = s;
        else if (field == 6 && m.allowedChains.length != 0) m.allowedChains[0] = s;
        else if (field == 7 && m.allowedVenues.length != 0) m.allowedVenues[0] = s;
        else if (field == 8) c.representationId = s;
        else if (field == 9) c.canonicalAsset.assetClass = s;
        else if (field == 10) c.canonicalAsset.idScheme = s;
        else if (field == 11) c.canonicalAsset.value = s;
        else if (field == 12) c.issuer = s;
        else if (field == 13) c.chain = s;
        else if (field == 14) c.venue = s;
        else if (field == 15) c.quantity.unit = s;
        else if (field == 16) c.executionPrice.numeratorUnit = s;
        else if (field == 17) c.executionPrice.denominatorUnit = s;
        else if (field == 18) c.notional.unit = s;
        else if (field == 19) c.feeTotal.unit = s;
        else if (field == 20) c.evaluationStateId = s;
    }

    /// @dev Append an entry (in or out of order), duplicate one, swap two, or empty a set.
    function _mutateSet(Attempt memory a, uint256 r) internal pure {
        uint256 which = r % 3;
        string[] memory set =
            which == 0 ? a.mandate.allowedIssuers : which == 1 ? a.mandate.allowedChains : a.mandate.allowedVenues;
        uint256 op = (r >> 8) % 4;
        string[] memory next;
        if (op == 0 || (op == 1 && set.length > 0)) {
            next = new string[](set.length + 1);
            for (uint256 i = 0; i < set.length; ++i) {
                next[i] = set[i];
            }
            // A long entry sorts last; a duplicate or a short one breaks the order.
            next[set.length] = op == 0 ? (r % 2 == 0 ? "zz.zz-zz:zz/zz_zzzzzzzzzzzzzzzzzzzzzzz" : "a") : set[0];
        } else if (op == 2 && set.length >= 2) {
            next = set;
            (next[0], next[1]) = (next[1], next[0]);
        } else {
            next = new string[](0);
        }
        if (which == 0) a.mandate.allowedIssuers = next;
        else if (which == 1) a.mandate.allowedChains = next;
        else a.mandate.allowedVenues = next;
    }

    function _mutateNumber(Attempt memory a, uint256 r) internal pure {
        uint256 which = r % 10;
        bool up = (r >> 8) % 2 == 0;
        if (which == 0) a.candidate.quantity.atoms = _nudge(a.candidate.quantity.atoms, up);
        else if (which == 1) a.candidate.notional.atoms = _nudge(a.candidate.notional.atoms, up);
        else if (which == 2) a.candidate.executionPrice.atoms = _nudge(a.candidate.executionPrice.atoms, up);
        else if (which == 3) a.candidate.feeTotal.atoms = _nudge(a.candidate.feeTotal.atoms, up);
        else if (which == 4) a.mandate.maxNotional.atoms = _nudge(a.mandate.maxNotional.atoms, up);
        else if (which == 5) a.mandate.economicLimit.atoms = _nudge(a.mandate.economicLimit.atoms, up);
        else if (which == 6) a.terms.fundingLimit = _nudge(a.terms.fundingLimit, up);
        else if (which == 7) a.candidate.notional.decimals = up ? a.candidate.notional.decimals + 1 : 0;
        else if (which == 8) a.candidate.executionPrice.decimals = up ? 39 : a.candidate.executionPrice.decimals + 1;
        else a.mandate.maxNotional.decimals = up ? a.mandate.maxNotional.decimals + 1 : 0;
    }

    function _nudge(uint256 x, bool up) internal pure returns (uint256) {
        if (up) return x == type(uint256).max ? x : x + 1;
        return x == 0 ? 0 : x - 1;
    }

    /// @dev Both signatures, honestly, over the mutated objects, under the gate's
    /// domain at `GATE` (the same address for both implementations).
    function _sign(Attempt memory a) internal view {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Mandate"), keccak256("1"), CHAIN, GATE));
        (bytes memory mandateBytes,) = encodings.mandate(a.mandate);
        (bytes memory candidateBytes,) = encodings.candidate(a.candidate);
        bytes32 mandateDigest = keccak256(mandateBytes);
        bytes32 mandateStruct =
            keccak256(abi.encode(keccak256("MandateAuthorization(bytes32 mandateDigest)"), mandateDigest));
        a.principalSignature = _signature(PRINCIPAL_KEY, keccak256(abi.encodePacked(hex"1901", domain, mandateStruct)));
        bytes32 commitment = keccak256(
            abi.encode(
                keccak256(
                    "ExecutionAuthorization(bytes32 mandateDigest,bytes32 candidateDigest,address recipient,uint256 fundingLimit,uint64 deadline,bytes executionData)"
                ),
                mandateDigest,
                keccak256(candidateBytes),
                a.terms.recipient,
                a.terms.fundingLimit,
                a.terms.deadline,
                keccak256(a.terms.executionData)
            )
        );
        a.agentSignature = _signature(AGENT_KEY, keccak256(abi.encodePacked(hex"1901", domain, commitment)));
    }

    function _signature(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------------
    // Outcomes
    // ------------------------------------------------------------------

    function _run(Attempt memory a) internal returns (Outcome memory o) {
        _prepare(a);
        vm.recordLogs();
        (o.ok, o.data) = GATE.call(
            abi.encodeCall(
                MandateExecutionGate.execute, (a.mandate, a.principalSignature, a.candidate, a.terms, a.agentSignature)
            )
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        o.logs = keccak256(abi.encode(logs));
        o.state = _state(a);
        vm.chainId(CHAIN);
    }

    /// @dev The replay record for this mandate and every balance the gate may move.
    function _state(Attempt memory a) internal view returns (bytes32) {
        (bytes memory mandateBytes,) = encodings.mandate(a.mandate);
        bytes memory balances;
        address[6] memory tokens = [FUNDING6, FUNDING18, AAPL, NVDA, SYNTH, EIGHT];
        for (uint256 i = 0; i < tokens.length; ++i) {
            MockERC20 t = MockERC20(tokens[i]);
            balances = bytes.concat(
                balances, abi.encode(t.balanceOf(principal), t.balanceOf(SINK), t.balanceOf(GATE), t.decimals())
            );
        }
        return
            keccak256(abi.encode(MandateExecutionGate(GATE).executionCommitmentOf(keccak256(mandateBytes)), balances));
    }

    function _assertSame(Outcome memory x, Outcome memory y, string memory label) internal pure {
        assertEq(x.ok, y.ok, string.concat(label, ": success"));
        assertEq(x.data, y.data, string.concat(label, ": return or revert data"));
        assertEq(x.logs, y.logs, string.concat(label, ": logs"));
        assertEq(x.state, y.state, string.concat(label, ": replay record and balances"));
    }
}
