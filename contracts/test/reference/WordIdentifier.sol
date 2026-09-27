// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

/// @title WordIdentifier
/// @notice The plain-Solidity word-level identifier validator and comparator
/// that were production code at Phase 6R.2B step 1 (`0aa496d`), retained as the
/// intermediate reference between the byte-at-a-time `ReferenceMandateCodec`
/// and the production SWAR code in `MandateCodec`. It classifies each byte by a
/// charset-mask shift — a different algorithm from both — so three independent
/// implementations must agree. Test code: nothing deployable imports it.
library WordIdentifier {
    uint256 internal constant IDENTIFIER_MAX_LENGTH = 128;
    uint256 internal constant MAX_SET_SIZE = 1024;

    /// @dev Bit `c` is set iff byte `c` is in `A-Z a-z 0-9 . _ - : /`.
    uint256 private constant IDENTIFIER_CHARSET = 0x7fffffe87fffffe07ffe00000000000;
    /// @dev Bit `c` is set iff byte `c` is a separator `. _ - : /`.
    uint256 private constant IDENTIFIER_SEPARATORS = 0x800000000400e00000000000;

    /// @dev A calldata slice converts to `bytes32` zero-padded on the right, and
    /// only the slice's own bytes are classified.
    function isIdentifier(string calldata s) internal pure returns (bool) {
        bytes calldata b = bytes(s);
        uint256 n = b.length;
        if (n == 0 || n > IDENTIFIER_MAX_LENGTH) return false;
        if (_isSeparator(uint8(b[0])) || _isSeparator(uint8(b[n - 1]))) return false;
        unchecked {
            for (uint256 i = 0; i < n; i += 32) {
                uint256 len = n - i < 32 ? n - i : 32;
                uint256 word = uint256(bytes32(b[i:i + len]));
                for (uint256 j = 0; j < len; ++j) {
                    if ((IDENTIFIER_CHARSET >> ((word >> (248 - 8 * j)) & 0xff)) & 1 == 0) return false;
                }
            }
        }
        return true;
    }

    function isIdentifierBytes(bytes memory b) internal pure returns (bool) {
        uint256 n = b.length;
        if (n == 0 || n > IDENTIFIER_MAX_LENGTH) return false;
        if (_isSeparator(uint8(b[0])) || _isSeparator(uint8(b[n - 1]))) return false;
        unchecked {
            for (uint256 i = 0; i < n; ++i) {
                if ((IDENTIFIER_CHARSET >> uint8(b[i])) & 1 == 0) return false;
            }
        }
        return true;
    }

    function _isSeparator(uint8 ch) private pure returns (bool) {
        return (IDENTIFIER_SEPARATORS >> ch) & 1 != 0;
    }

    function isIdentifierSet(string[] calldata values) internal pure returns (bool) {
        uint256 n = values.length;
        if (n > MAX_SET_SIZE) return false;
        for (uint256 i = 0; i < n; ++i) {
            if (!isIdentifier(values[i])) return false;
            if (i > 0 && compareEncoded(bytes(values[i - 1]), bytes(values[i])) >= 0) return false;
        }
        return true;
    }

    /// @dev Length first, then equal-length operands a zero-padded word at a time.
    function compareEncoded(bytes calldata a, bytes calldata b) internal pure returns (int256) {
        uint256 n = a.length;
        if (n != b.length) return n < b.length ? int256(-1) : int256(1);
        unchecked {
            for (uint256 i = 0; i < n; i += 32) {
                uint256 end = n - i < 32 ? n : i + 32;
                bytes32 x = bytes32(a[i:end]);
                bytes32 y = bytes32(b[i:end]);
                if (x != y) return x < y ? int256(-1) : int256(1);
            }
        }
        return 0;
    }
}
