// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {SIDE_BUY} from "../src/MandateTypes.sol";

import {GasBench} from "./utils/GasBench.sol";

/// @notice One-variable gas sweeps over the dynamic inputs of an execution
/// (docs/phase-6r2a-gas-profile.md §D–G). Every point is its own `setUp`-deployed
/// gate with its own tokens (see `GasBench`), and every point settles.
///
/// The baseline is `_uniformShape(8)`: every choosable identifier 8 bytes,
/// one-entry sets, no route data. A sweep changes exactly one thing.

// ----------------------------------------------------------------------
// Identifier length (§D)
// ----------------------------------------------------------------------

/// @dev Which identifier a sweep lengthens. The representation identifier
/// (`eip155:<chain>/erc20:<address>`, 59 bytes here) and the chain identifier
/// (`eip155:46630`) are derived by the gate from the chain and the token, so a
/// profile cannot lengthen them; they are constant in every benchmark.
enum IdentifierField {
    ASSET_VALUE,
    ASSET_ALL_COMPONENTS,
    ISSUER,
    VENUE,
    QUANTITY_UNIT,
    SETTLEMENT_UNIT,
    EVALUATION_STATE,
    NON_TARGET_SET_ENTRIES,
    ALL
}

abstract contract IdentifierLengthSweep is GasBench {
    uint256[6] internal LENGTHS = [uint256(8), 16, 32, 64, 96, 128];
    Bench[6] internal benches;

    function _field() internal pure virtual returns (IdentifierField);

    function _fieldName() internal pure virtual returns (string memory);

    function setUp() public override {
        super.setUp();
        for (uint256 i = 0; i < LENGTHS.length; ++i) {
            benches[i] = _deployBench(_shapeAt(LENGTHS[i]));
        }
    }

    /// @dev The baseline with the swept field at `len` bytes. For
    /// NON_TARGET_SET_ENTRIES every set carries one extra entry at every point
    /// (so the count is constant) and only that entry's length changes.
    function _shapeAt(uint256 len) internal pure returns (Shape memory s) {
        IdentifierField f = _field();
        bool all = f == IdentifierField.ALL;
        s = _uniformShape(8);
        if (f == IdentifierField.ASSET_VALUE) s.asset.value = _ident("val", len, 0);
        if (all || f == IdentifierField.ASSET_ALL_COMPONENTS) {
            s.asset.assetClass = _ident("cls", len, 0);
            s.asset.idScheme = _ident("sch", len, 0);
            s.asset.value = _ident("val", len, 0);
        }
        if (all || f == IdentifierField.ISSUER) s.issuer = _ident("iss", len, 0);
        if (all || f == IdentifierField.VENUE) s.venue = _ident("ven", len, 0);
        if (all || f == IdentifierField.QUANTITY_UNIT) s.quantityUnit = _ident("qun", len, 0);
        if (all || f == IdentifierField.SETTLEMENT_UNIT) s.settlementUnit = _ident("sun", len, 0);
        if (all || f == IdentifierField.EVALUATION_STATE) s.evaluationStateId = _ident("sta", len, 0);
        s.issuers = _list(s.issuer);
        s.venues = _list(s.venue);
        if (all || f == IdentifierField.NON_TARGET_SET_ENTRIES) {
            s.issuers = _pair(s.issuer, _ident("iss", len, 1));
            s.venues = _pair(s.venue, _ident("ven", len, 1));
            s.chains = _pair(CHAIN_ID_STRING, _ident("chn", len, 1));
        }
    }

    function _pair(string memory a, string memory b) internal pure returns (string[] memory) {
        string[] memory out = new string[](2);
        out[0] = a;
        out[1] = b;
        return _sorted(out);
    }

    /// @dev Records only: how gas responds to length is what is being measured,
    /// and a word-at-a-time validator legitimately flattens it.
    function test_identifierLengthSweep() public {
        for (uint256 i = 0; i < LENGTHS.length; ++i) {
            Measurement memory r = _measureShape(_shapeAt(LENGTHS[i]), benches[i], SIDE_BUY);
            _log(string.concat("idlen.", _fieldName()), vm.toString(LENGTHS[i]), r);
        }
    }
}

contract IdentifierLengthSweepAssetValue is IdentifierLengthSweep {
    function _field() internal pure override returns (IdentifierField) {
        return IdentifierField.ASSET_VALUE;
    }

    function _fieldName() internal pure override returns (string memory) {
        return "asset.value";
    }
}

contract IdentifierLengthSweepAssetAll is IdentifierLengthSweep {
    function _field() internal pure override returns (IdentifierField) {
        return IdentifierField.ASSET_ALL_COMPONENTS;
    }

    function _fieldName() internal pure override returns (string memory) {
        return "asset.all3";
    }
}

contract IdentifierLengthSweepIssuer is IdentifierLengthSweep {
    function _field() internal pure override returns (IdentifierField) {
        return IdentifierField.ISSUER;
    }

    function _fieldName() internal pure override returns (string memory) {
        return "issuer";
    }
}

contract IdentifierLengthSweepVenue is IdentifierLengthSweep {
    function _field() internal pure override returns (IdentifierField) {
        return IdentifierField.VENUE;
    }

    function _fieldName() internal pure override returns (string memory) {
        return "venue";
    }
}

contract IdentifierLengthSweepQuantityUnit is IdentifierLengthSweep {
    function _field() internal pure override returns (IdentifierField) {
        return IdentifierField.QUANTITY_UNIT;
    }

    function _fieldName() internal pure override returns (string memory) {
        return "quantityUnit";
    }
}

contract IdentifierLengthSweepSettlementUnit is IdentifierLengthSweep {
    function _field() internal pure override returns (IdentifierField) {
        return IdentifierField.SETTLEMENT_UNIT;
    }

    function _fieldName() internal pure override returns (string memory) {
        return "settlementUnit";
    }
}

contract IdentifierLengthSweepEvaluationState is IdentifierLengthSweep {
    function _field() internal pure override returns (IdentifierField) {
        return IdentifierField.EVALUATION_STATE;
    }

    function _fieldName() internal pure override returns (string memory) {
        return "evaluationStateId";
    }
}

contract IdentifierLengthSweepNonTargetEntries is IdentifierLengthSweep {
    function _field() internal pure override returns (IdentifierField) {
        return IdentifierField.NON_TARGET_SET_ENTRIES;
    }

    function _fieldName() internal pure override returns (string memory) {
        return "nonTargetSetEntries.x3";
    }
}

contract IdentifierLengthSweepAll is IdentifierLengthSweep {
    function _field() internal pure override returns (IdentifierField) {
        return IdentifierField.ALL;
    }

    function _fieldName() internal pure override returns (string memory) {
        return "all";
    }
}

// ----------------------------------------------------------------------
// Route data (§E)
// ----------------------------------------------------------------------

/// @notice Route data settles only through `LeanAdapter` (the fixture adapter
/// refuses any), so this sweep prices the gate's receiving, committing and
/// forwarding of route bytes plus the lean adapter's receipt of them, on
/// otherwise the `_uniformShape(8)` attempt. Every route byte is non-zero.
contract RouteDataSweep is GasBench {
    uint256[9] internal SIZES = [uint256(0), 32, 64, 128, 256, 512, 1_024, 2_048, 4_096];
    Bench[9] internal benches;

    function _shapeAt(uint256 size) internal pure returns (Shape memory s) {
        s = _uniformShape(8);
        s.routeBytes = size;
    }

    function setUp() public override {
        super.setUp();
        for (uint256 i = 0; i < SIZES.length; ++i) {
            Shape memory s = _shapeAt(SIZES[i]);
            benches[i] = _deployBench(s);
            // Zero route bytes would otherwise take the fixture adapter; the
            // whole sweep uses the same lean adapter so only the route changes.
            if (SIZES[i] == 0) _stockBench(benches[i], true);
        }
    }

    function test_routeDataSweep() public {
        for (uint256 i = 0; i < SIZES.length; ++i) {
            Measurement memory r = _measureShape(_shapeAt(SIZES[i]), benches[i], SIDE_BUY);
            _log("route", vm.toString(SIZES[i]), r);
        }
    }
}

// ----------------------------------------------------------------------
// Allowlist size and position (§F)
// ----------------------------------------------------------------------

enum SetDimension {
    ISSUERS,
    CHAINS,
    VENUES
}

/// @notice Sets of 1, 2, 4, 8 and 16 entries with the market's own entry first,
/// in the middle or last. Every entry of a set has the same length (16 bytes for
/// issuers and venues, 12 for CAIP-2 chains), so only count and position vary.
abstract contract AllowlistSweep is GasBench {
    uint256[5] internal COUNTS = [uint256(1), 2, 4, 8, 16];
    /// @dev 0 first, 1 middle, 2 last. A one-entry set has only "first".
    Bench[5][3] internal benches;

    function _dimension() internal pure virtual returns (SetDimension);

    function _dimensionName() internal pure virtual returns (string memory);

    function _position(uint256 count, uint256 where) internal pure returns (uint256) {
        if (where == 0) return 0;
        if (where == 1) return count / 2;
        return count - 1;
    }

    /// @dev `count` entries, the market's own at index `target`. Entries below
    /// it sort lower on their first differing byte and entries above it higher.
    function _entries(uint256 count, uint256 target) internal pure returns (string[] memory out) {
        SetDimension d = _dimension();
        out = new string[](count);
        for (uint256 i = 0; i < count; ++i) {
            if (i == target) out[i] = _own(d);
            else if (d == SetDimension.CHAINS) out[i] = string.concat(i < target ? "eip155:1" : "eip155:5", _four(i));
            else out[i] = _ident(i < target ? _lowHead(d) : _highHead(d), 16, i);
        }
    }

    function _own(SetDimension d) internal pure returns (string memory) {
        if (d == SetDimension.CHAINS) return CHAIN_ID_STRING;
        return d == SetDimension.ISSUERS ? _ident("issuerm", 16, 0) : _ident("venuem", 16, 0);
    }

    function _lowHead(SetDimension d) internal pure returns (string memory) {
        return d == SetDimension.ISSUERS ? "issuera" : "venuea";
    }

    function _highHead(SetDimension d) internal pure returns (string memory) {
        return d == SetDimension.ISSUERS ? "issuerz" : "venuez";
    }

    function _four(uint256 i) internal pure returns (string memory) {
        bytes memory out = new bytes(4);
        for (uint256 k = 4; k > 0; --k) {
            out[k - 1] = bytes1(uint8(48 + i % 10));
            i /= 10;
        }
        return string(out);
    }

    function _shapeAt(uint256 count, uint256 where) internal pure returns (Shape memory s) {
        s = _uniformShape(8);
        SetDimension d = _dimension();
        s.issuer = _own(SetDimension.ISSUERS);
        s.venue = _own(SetDimension.VENUES);
        s.issuers = _list(s.issuer);
        s.venues = _list(s.venue);
        string[] memory set = _entries(count, _position(count, where));
        if (d == SetDimension.ISSUERS) s.issuers = set;
        if (d == SetDimension.CHAINS) s.chains = set;
        if (d == SetDimension.VENUES) s.venues = set;
    }

    function setUp() public override {
        super.setUp();
        for (uint256 c = 0; c < COUNTS.length; ++c) {
            for (uint256 w = 0; w < 3; ++w) {
                if (COUNTS[c] == 1 && w > 0) continue;
                benches[w][c] = _deployBench(_shapeAt(COUNTS[c], w));
            }
        }
    }

    function test_allowlistSweep() public {
        string[3] memory whereName = ["first", "middle", "last"];
        uint256 firstOfOne;
        for (uint256 c = 0; c < COUNTS.length; ++c) {
            for (uint256 w = 0; w < 3; ++w) {
                if (COUNTS[c] == 1 && w > 0) continue;
                Measurement memory r = _measureShape(_shapeAt(COUNTS[c], w), benches[w][c], SIDE_BUY);
                _log(
                    string.concat("allowlist.", _dimensionName()),
                    string.concat(vm.toString(COUNTS[c]), ".", whereName[w]),
                    r
                );
                if (c == 0) firstOfOne = r.executionGas;
                else assertGt(r.executionGas, firstOfOne, "a longer set costs more to validate");
            }
        }
    }
}

contract AllowlistSweepIssuers is AllowlistSweep {
    function _dimension() internal pure override returns (SetDimension) {
        return SetDimension.ISSUERS;
    }

    function _dimensionName() internal pure override returns (string memory) {
        return "issuers";
    }
}

contract AllowlistSweepChains is AllowlistSweep {
    function _dimension() internal pure override returns (SetDimension) {
        return SetDimension.CHAINS;
    }

    function _dimensionName() internal pure override returns (string memory) {
        return "chains";
    }
}

contract AllowlistSweepVenues is AllowlistSweep {
    function _dimension() internal pure override returns (SetDimension) {
        return SetDimension.VENUES;
    }

    function _dimensionName() internal pure override returns (string memory) {
        return "venues";
    }
}
