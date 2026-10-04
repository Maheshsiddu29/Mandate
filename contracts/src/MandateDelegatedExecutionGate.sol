// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {
    Candidate,
    ExecutionTerms,
    Mandate,
    Market,
    MarketConfig,
    MARKET_FIXTURE,
    SIDE_BUY,
    SYNTHETIC_FORBIDDEN
} from "./MandateTypes.sol";
import {GateArithmetic} from "./libraries/GateArithmetic.sol";
import {ExecutionOrder, IMandateExecutionAdapter} from "./interfaces/IMandateExecutionAdapter.sol";
import {MandateCodec} from "./libraries/MandateCodec.sol";
import {FixtureVenue} from "./fixture/FixtureVenue.sol";
import {FixtureVenueAdapter} from "./fixture/FixtureVenueAdapter.sol";

/// @title MandateDelegatedExecutionGate
/// @notice C2.3 bounded delegated execution: the human signs a reusable
/// authority boundary once; Mandate's ephemeral delegate authorizes each exact
/// in-policy execution. Distinct from the frozen `MandateExecutionGate` (V2).
///
/// Authority chain on every `execute`:
///
/// 1. chain is the deployment chain;
/// 2. principal signed `DelegatedPortfolioAuthorizationV3` over this delegation
///    under this gate's EIP-712 domain (version "3");
/// 3. delegation is unrevoked and inside its validity window;
/// 4. per-execution mandate/candidate re-encode and bind to the signed scope
///    (principal, agent, representation, funding token, recipient=principal);
/// 5. agent signed `ExecutionAuthorization` (same commitment shape as V2);
/// 6. Mandate delegate signed `DelegatedExecutionApproval` for this exact
///    execution nonce and economic choices;
/// 7. execution nonce is unused; remaining cumulative capacity covers the debit;
/// 8. nonce and capacity are consumed, then settlement runs; measured deltas
///    must match; any revert unwinds the consumption.
///
/// See docs/demo/c2-3-delegated-execution.md.
contract MandateDelegatedExecutionGate is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_PROFILE_SET_SIZE = 16;
    uint256 public constant MAX_EXECUTION_DATA_BYTES = 4_096;
    uint256 public constant MAX_MARKETS = 32;
    uint256 private constant FIXTURE_FEE_BPS_LIMIT = 10_000;

    // ------------------------------------------------------------------
    // EIP-712 (domain version "3"; distinct from V2 gate version "1")
    // ------------------------------------------------------------------

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Mandate");
    bytes32 private constant VERSION_HASH = keccak256("3");

    /// @dev Principal-signed reusable boundary. One signature authorizes many
    /// exact executions under the cumulative debit cap.
    bytes32 public constant DELEGATED_PORTFOLIO_AUTHORIZATION_V3_TYPEHASH = keccak256(
        "DelegatedPortfolioAuthorizationV3(bytes32 portfolioMandateDigest,bytes32 initialAllocationDigest,bytes32 sessionDigest,address principal,address delegate,address agent,bytes32 representationIdHash,address fundingToken,uint256 cumulativeDebitLimit,uint64 validAfter,uint64 validUntil,uint64 generation)"
    );

    /// @dev Agent-signed execution commitment (same field shape as V2).
    bytes32 public constant EXECUTION_AUTHORIZATION_TYPEHASH = keccak256(
        "ExecutionAuthorization(bytes32 mandateDigest,bytes32 candidateDigest,address recipient,uint256 fundingLimit,uint64 deadline,bytes executionData)"
    );

    /// @dev Mandate-delegate-signed exact execution approval (per nonce).
    bytes32 public constant DELEGATED_EXECUTION_APPROVAL_TYPEHASH = keccak256(
        "DelegatedExecutionApproval(bytes32 delegationDigest,bytes32 mandateDigest,bytes32 candidateDigest,address recipient,uint256 fundingLimit,uint64 deadline,bytes32 executionDataHash,uint64 executionNonce)"
    );

    /// @notice Human-signed reusable delegation bound into EIP-712.
    struct Delegation {
        bytes32 portfolioMandateDigest;
        bytes32 initialAllocationDigest;
        bytes32 sessionDigest;
        address principal;
        address delegate;
        address agent;
        bytes32 representationIdHash;
        address fundingToken;
        uint256 cumulativeDebitLimit;
        uint64 validAfter;
        uint64 validUntil;
        uint64 generation;
    }

    uint256 public immutable CHAIN_ID;

    bytes32 private immutable _DOMAIN_SEPARATOR;
    bytes32 private immutable _CHAIN_HASH;

    mapping(bytes32 representationIdHash => Market) private _markets;
    mapping(bytes32 representationIdHash => address venue) private _fixtureVenues;

    /// @dev Cumulative funding-token atoms successfully debited under a delegation.
    mapping(bytes32 delegationDigest => uint256 used) private _usedDebit;

    /// @dev Per-delegation execution nonce replay protection.
    mapping(bytes32 delegationDigest => mapping(uint64 executionNonce => bool used)) private _usedNonce;

    /// @dev Principal-revoked delegations.
    mapping(bytes32 delegationDigest => bool revoked) private _revoked;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event MarketSupported(
        bytes32 indexed representationIdHash,
        address indexed representation,
        address indexed fundingToken,
        address adapter,
        address fixtureVenue,
        uint256 fixtureVenuePrice,
        string representationId
    );

    event DelegationRevoked(bytes32 indexed delegationDigest, address indexed principal, uint64 generation);

    event DelegatedMandateExecuted(
        bytes32 indexed delegationDigest,
        bytes32 indexed executionCommitment,
        address indexed principal,
        bytes32 mandateDigest,
        bytes32 candidateDigest,
        address agent,
        address delegate,
        uint64 executionNonce,
        address inputToken,
        address outputToken,
        uint256 actualDebit,
        uint256 actualCredit,
        uint256 cumulativeUsed
    );

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error InvalidMarket();
    error RealMarketStateSourceRequired();
    error FixturePriceNotRepresentable();
    error ExecutionProfileExceeded();
    error WrongChain();
    error UnsupportedMandateVersion();
    error MalformedMandate();
    error PrincipalSignatureInvalid();
    error MalformedCandidate();
    error UnsupportedRepresentation();
    error AgentSignatureInvalid();
    error DelegateSignatureInvalid();
    error DelegationNotYetValid();
    error DelegationExpired();
    error DelegationRevokedError();
    error InvalidDelegationWindow();
    error InvalidDelegationParties();
    error DelegationScopeMismatch();
    error ExecutionDeadlinePassed();
    error ExecutionNonceAlreadyUsed();
    error CumulativeDebitExceeded(uint256 used, uint256 debit, uint256 limit);
    error AgentMismatch();
    error SideMismatch();
    error CanonicalAssetMismatch();
    error RepresentationAssetMismatch();
    error ChainMismatch();
    error ChainNotAllowed();
    error VenueMismatch();
    error VenueNotAllowed();
    error IssuerMismatch();
    error IssuerNotAllowed();
    error SyntheticNotAllowed();
    error QuantityUnitMismatch();
    error ZeroQuantity();
    error SettlementUnitMismatch();
    error EconomicUnitMismatch();
    error FixturePriceMismatch();
    error NotionalOutOfRange();
    error NotionalInconsistent(uint256 declared, uint256 floorAtoms, uint256 ceilAtoms);
    error MaxNotionalExceeded();
    error DeclaredEconomicValueOutOfRange();
    error DeclaredTotalDebitExceeded();
    error DeclaredFeesExceedNotional();
    error DeclaredTotalCreditBelowMinimum();
    error RecipientNotPrincipal();
    error FundingLimitExceedsMandate(uint256 fundingLimit, uint256 mandateBound);
    error FundingLimitBelowMandate(uint256 fundingLimit, uint256 mandateBound);
    error TokenDecimalsChanged(address token);
    error DebitExceedsLimit(uint256 actualDebit, uint256 limit);
    error CreditBelowMinimum(uint256 actualCredit, uint256 minimum);
    error DebitNotExact(uint256 actualDebit, uint256 expected);
    error CreditNotExact(uint256 actualCredit, uint256 expected);
    error SideNotSupported();
    error NotDelegationPrincipal();

    // ------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------

    constructor(MarketConfig[] memory markets) {
        if (markets.length == 0 || markets.length > MAX_MARKETS) revert InvalidMarket();
        CHAIN_ID = block.chainid;
        _CHAIN_HASH = keccak256(bytes(MandateCodec.caip2(block.chainid)));
        _DOMAIN_SEPARATOR =
            keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));

        for (uint256 i = 0; i < markets.length; ++i) {
            _addMarket(markets[i]);
        }
    }

    function _addMarket(MarketConfig memory config) private {
        if (
            config.representation == address(0) || config.fundingToken == address(0)
                || config.representation == config.fundingToken || config.representation.code.length == 0
                || config.fundingToken.code.length == 0
        ) revert InvalidMarket();
        if (config.classification != MARKET_FIXTURE) revert RealMarketStateSourceRequired();
        if (
            !MandateCodec.isIdentifierBytes(bytes(config.canonicalAsset.assetClass))
                || !MandateCodec.isIdentifierBytes(bytes(config.canonicalAsset.idScheme))
                || !MandateCodec.isIdentifierBytes(bytes(config.canonicalAsset.value))
                || !MandateCodec.isIdentifierBytes(bytes(config.issuer))
                || !MandateCodec.isIdentifierBytes(bytes(config.venue))
                || !MandateCodec.isIdentifierBytes(bytes(config.quantityUnit))
                || !MandateCodec.isIdentifierBytes(bytes(config.settlementUnit))
                || !MandateCodec.isIdentifierBytes(bytes(config.fixturePrice.numeratorUnit))
                || !MandateCodec.isIdentifierBytes(bytes(config.fixturePrice.denominatorUnit))
        ) revert InvalidMarket();
        if (
            keccak256(bytes(config.fixturePrice.numeratorUnit)) != keccak256(bytes(config.settlementUnit))
                || keccak256(bytes(config.fixturePrice.denominatorUnit)) != keccak256(bytes(config.quantityUnit))
                || config.fixturePrice.decimals > MandateCodec.MAX_DECIMALS || config.fixturePrice.atoms == 0
                || config.fixtureFeeBps >= FIXTURE_FEE_BPS_LIMIT
        ) revert InvalidMarket();

        // slither-disable-next-line calls-loop
        uint8 representationDecimals = IERC20Metadata(config.representation).decimals();
        // slither-disable-next-line calls-loop
        uint8 fundingDecimals = IERC20Metadata(config.fundingToken).decimals();
        if (representationDecimals > MandateCodec.MAX_DECIMALS || fundingDecimals > MandateCodec.MAX_DECIMALS) {
            revert InvalidMarket();
        }

        string memory representationId = MandateCodec.representationId(block.chainid, config.representation);
        bytes32 key = keccak256(bytes(representationId));
        if (_markets[key].representation != address(0)) revert InvalidMarket();

        (bool representable, uint256 venuePrice) =
            _fundingAtomsPerToken(config.fixturePrice.atoms, config.fixturePrice.decimals, fundingDecimals);
        if (!representable) revert FixturePriceNotRepresentable();

        FixtureVenue venue = new FixtureVenue(
            IERC20(config.representation),
            IERC20(config.fundingToken),
            representationDecimals,
            fundingDecimals,
            venuePrice,
            config.fixtureFeeBps
        );
        FixtureVenueAdapter adapter = new FixtureVenueAdapter(address(this), venue);

        Market storage market = _markets[key];
        market.representation = config.representation;
        market.fundingToken = config.fundingToken;
        market.adapter = address(adapter);
        market.representationDecimals = representationDecimals;
        market.fundingDecimals = fundingDecimals;
        market.synthetic = config.synthetic;
        market.classification = config.classification;
        market.canonicalAssetHash = MandateCodec.assetHashMemory(config.canonicalAsset);
        market.issuerHash = keccak256(bytes(config.issuer));
        market.venueHash = keccak256(bytes(config.venue));
        market.quantityUnitHash = keccak256(bytes(config.quantityUnit));
        market.settlementUnitHash = keccak256(bytes(config.settlementUnit));
        market.fixturePriceDecimals = config.fixturePrice.decimals;
        market.fixturePriceAtoms = config.fixturePrice.atoms;
        _fixtureVenues[key] = address(venue);
        emit MarketSupported(
            key,
            config.representation,
            config.fundingToken,
            address(adapter),
            address(venue),
            venuePrice,
            representationId
        );
    }

    function _fundingAtomsPerToken(uint256 atoms, uint8 priceDecimals, uint8 fundingDecimals)
        private
        pure
        returns (bool representable, uint256 fundingAtoms)
    {
        if (fundingDecimals >= priceDecimals) {
            uint256 factor = 10 ** uint256(fundingDecimals - priceDecimals);
            if (atoms > type(uint256).max / factor) return (false, 0);
            return (true, atoms * factor);
        }
        uint256 divisor = 10 ** uint256(priceDecimals - fundingDecimals);
        if (atoms % divisor != 0) return (false, 0);
        return (true, atoms / divisor);
    }

    // ------------------------------------------------------------------
    // Revocation
    // ------------------------------------------------------------------

    /// @notice Principal-only hard stop for a reusable delegation.
    function revokeDelegation(Delegation calldata delegation) external {
        if (msg.sender != delegation.principal) revert NotDelegationPrincipal();
        bytes32 digest = delegationDigest(delegation);
        _revoked[digest] = true;
        emit DelegationRevoked(digest, delegation.principal, delegation.generation);
    }

    // ------------------------------------------------------------------
    // Execution
    // ------------------------------------------------------------------

    struct Plan {
        bytes32 delegationDigest;
        bytes32 mandateDigest;
        bytes32 candidateDigest;
        bytes32 executionCommitment;
        Market market;
        uint8 side;
        address inputToken;
        address outputToken;
        uint256 inputAmount;
        uint256 minOutput;
        uint256 exactQuantity;
        uint64 executionNonce;
    }

    /// @notice Execute one exact action under a reusable principal delegation.
    function execute(
        Delegation calldata delegation,
        bytes calldata principalSignature,
        Mandate calldata mandate,
        Candidate calldata candidate,
        ExecutionTerms calldata terms,
        bytes calldata agentSignature,
        uint64 executionNonce,
        bytes calldata delegateSignature
    ) external nonReentrant returns (bytes32 executionCommitment, uint256 actualDebit, uint256 actualCredit) {
        Plan memory plan = _authorize(
            delegation,
            principalSignature,
            mandate,
            candidate,
            terms,
            agentSignature,
            executionNonce,
            delegateSignature
        );

        // Effects before interactions: consume nonce and tentative capacity
        // (fundingLimit) before any external call. A revert below unwinds both.
        // After settlement, capacity is adjusted to the measured debit so a
        // venue refund does not permanently consume unused tentative room.
        _usedNonce[plan.delegationDigest][plan.executionNonce] = true;
        _usedDebit[plan.delegationDigest] += plan.inputAmount;

        (actualDebit, actualCredit) = _settle(plan, mandate.principal, terms);

        _usedDebit[plan.delegationDigest] =
            _usedDebit[plan.delegationDigest] - plan.inputAmount + actualDebit;

        uint256 cumulativeUsed = _usedDebit[plan.delegationDigest];
        emit DelegatedMandateExecuted(
            plan.delegationDigest,
            plan.executionCommitment,
            mandate.principal,
            plan.mandateDigest,
            plan.candidateDigest,
            mandate.agent,
            delegation.delegate,
            plan.executionNonce,
            plan.inputToken,
            plan.outputToken,
            actualDebit,
            actualCredit,
            cumulativeUsed
        );
        return (plan.executionCommitment, actualDebit, actualCredit);
    }

    function _authorize(
        Delegation calldata delegation,
        bytes calldata principalSignature,
        Mandate calldata mandate,
        Candidate calldata candidate,
        ExecutionTerms calldata terms,
        bytes calldata agentSignature,
        uint64 executionNonce,
        bytes calldata delegateSignature
    ) private view returns (Plan memory plan) {
        if (block.chainid != CHAIN_ID) revert WrongChain();
        _checkDelegationShape(delegation);

        plan.delegationDigest = delegationDigest(delegation);
        if (!_signedBy(plan.delegationDigest, principalSignature, delegation.principal)) {
            revert PrincipalSignatureInvalid();
        }
        if (_revoked[plan.delegationDigest]) revert DelegationRevokedError();
        _checkDelegationTime(delegation);

        MandateCodec.Validity validity = MandateCodec.validateMandate(mandate);
        if (validity == MandateCodec.Validity.UNSUPPORTED_VERSION) revert UnsupportedMandateVersion();
        if (validity != MandateCodec.Validity.VALID) revert MalformedMandate();
        if (
            mandate.allowedIssuers.length > MAX_PROFILE_SET_SIZE || mandate.allowedChains.length > MAX_PROFILE_SET_SIZE
                || mandate.allowedVenues.length > MAX_PROFILE_SET_SIZE
        ) revert ExecutionProfileExceeded();

        // V3 live path is Stock BUY only tonight.
        if (mandate.side != SIDE_BUY) revert SideNotSupported();

        if (mandate.principal != delegation.principal || mandate.agent != delegation.agent) {
            revert DelegationScopeMismatch();
        }

        plan.mandateDigest = MandateCodec.mandateDigest(mandate);
        if (!MandateCodec.isValidCandidate(candidate)) revert MalformedCandidate();
        if (terms.executionData.length > MAX_EXECUTION_DATA_BYTES) revert ExecutionProfileExceeded();
        plan.candidateDigest = MandateCodec.candidateDigest(candidate);

        bytes32 repKey = keccak256(bytes(candidate.representationId));
        if (repKey != delegation.representationIdHash) revert DelegationScopeMismatch();
        plan.market = _markets[repKey];
        if (plan.market.representation == address(0)) revert UnsupportedRepresentation();
        if (plan.market.fundingToken != delegation.fundingToken) revert DelegationScopeMismatch();

        plan.executionCommitment = keccak256(
            abi.encode(
                EXECUTION_AUTHORIZATION_TYPEHASH,
                plan.mandateDigest,
                plan.candidateDigest,
                terms.recipient,
                terms.fundingLimit,
                terms.deadline,
                keccak256(terms.executionData)
            )
        );
        if (!_signedBy(plan.executionCommitment, agentSignature, mandate.agent)) revert AgentSignatureInvalid();

        bytes32 approvalStruct = keccak256(
            abi.encode(
                DELEGATED_EXECUTION_APPROVAL_TYPEHASH,
                plan.delegationDigest,
                plan.mandateDigest,
                plan.candidateDigest,
                terms.recipient,
                terms.fundingLimit,
                terms.deadline,
                keccak256(terms.executionData),
                executionNonce
            )
        );
        if (!_signedBy(approvalStruct, delegateSignature, delegation.delegate)) revert DelegateSignatureInvalid();

        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > terms.deadline) revert ExecutionDeadlinePassed();
        if (_usedNonce[plan.delegationDigest][executionNonce]) revert ExecutionNonceAlreadyUsed();

        _checkBinding(mandate, candidate, plan.market);
        _checkEconomics(mandate, candidate, plan.market);
        _plan(plan, mandate, candidate, terms);
        plan.executionNonce = executionNonce;

        uint256 used = _usedDebit[plan.delegationDigest];
        if (used > type(uint256).max - plan.inputAmount || used + plan.inputAmount > delegation.cumulativeDebitLimit) {
            revert CumulativeDebitExceeded(used, plan.inputAmount, delegation.cumulativeDebitLimit);
        }
    }

    function _checkDelegationShape(Delegation calldata d) private pure {
        if (
            d.principal == address(0) || d.delegate == address(0) || d.agent == address(0)
                || d.fundingToken == address(0) || d.delegate == d.agent || d.delegate == d.principal
                || d.agent == d.principal || d.cumulativeDebitLimit == 0 || d.validUntil == 0
                || d.validAfter >= d.validUntil
        ) revert InvalidDelegationParties();
        // No "forever" / uint-max bypass: require a finite window under 2^63 seconds.
        if (d.validUntil > uint64(type(int64).max)) revert InvalidDelegationWindow();
    }

    // slither-disable-next-line timestamp
    function _checkDelegationTime(Delegation calldata d) private view {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < d.validAfter) revert DelegationNotYetValid();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= d.validUntil) revert DelegationExpired();
    }

    function _checkEconomics(Mandate calldata mandate, Candidate calldata candidate, Market memory market)
        private
        pure
    {
        bytes32 settlementUnitHash = market.settlementUnitHash;
        if (
            keccak256(bytes(candidate.notional.unit)) != settlementUnitHash
                || keccak256(bytes(candidate.feeTotal.unit)) != settlementUnitHash
                || keccak256(bytes(candidate.executionPrice.numeratorUnit)) != settlementUnitHash
                || keccak256(bytes(candidate.executionPrice.denominatorUnit)) != market.quantityUnitHash
        ) revert EconomicUnitMismatch();
        if (
            GateArithmetic.compare(
                    candidate.executionPrice.atoms,
                    candidate.executionPrice.decimals,
                    market.fixturePriceAtoms,
                    market.fixturePriceDecimals
                ) != 0
        ) revert FixturePriceMismatch();

        (bool representable, uint256 floorAtoms, uint256 ceilAtoms) = GateArithmetic.notionalBounds(
            candidate.quantity.atoms,
            candidate.quantity.decimals,
            candidate.executionPrice.atoms,
            candidate.executionPrice.decimals,
            candidate.notional.decimals
        );
        if (!representable) revert NotionalOutOfRange();
        if (candidate.notional.atoms < floorAtoms || candidate.notional.atoms > ceilAtoms) {
            revert NotionalInconsistent(candidate.notional.atoms, floorAtoms, ceilAtoms);
        }
        _checkMaxNotional(mandate, candidate, market);

        if (mandate.side == SIDE_BUY) {
            (bool sumRepresentable, bool within) = GateArithmetic.sumWithinLimit(
                candidate.notional.atoms,
                candidate.notional.decimals,
                candidate.feeTotal.atoms,
                candidate.feeTotal.decimals,
                mandate.economicLimit.atoms,
                mandate.economicLimit.decimals
            );
            if (!sumRepresentable) revert DeclaredEconomicValueOutOfRange();
            if (!within) revert DeclaredTotalDebitExceeded();
        } else {
            if (
                GateArithmetic.compare(
                        candidate.feeTotal.atoms,
                        candidate.feeTotal.decimals,
                        candidate.notional.atoms,
                        candidate.notional.decimals
                    ) >= 0
            ) revert DeclaredFeesExceedNotional();
            if (
                !GateArithmetic.differenceMeetsLimit(
                    candidate.notional.atoms,
                    candidate.notional.decimals,
                    candidate.feeTotal.atoms,
                    candidate.feeTotal.decimals,
                    mandate.economicLimit.atoms,
                    mandate.economicLimit.decimals
                )
            ) revert DeclaredTotalCreditBelowMinimum();
        }
    }

    function _checkMaxNotional(Mandate calldata mandate, Candidate calldata candidate, Market memory market)
        private
        pure
    {
        if (
            GateArithmetic.compare(
                    candidate.notional.atoms,
                    candidate.notional.decimals,
                    mandate.maxNotional.atoms,
                    mandate.maxNotional.decimals
                ) > 0
        ) revert MaxNotionalExceeded();
        // slither-disable-next-line unused-return
        (bool productRepresentable,, uint256 productCeil) = GateArithmetic.notionalBounds(
            candidate.quantity.atoms,
            candidate.quantity.decimals,
            market.fixturePriceAtoms,
            market.fixturePriceDecimals,
            mandate.maxNotional.decimals
        );
        if (!productRepresentable || productCeil > mandate.maxNotional.atoms) revert MaxNotionalExceeded();
    }

    // slither-disable-next-line cyclomatic-complexity
    function _checkBinding(Mandate calldata mandate, Candidate calldata candidate, Market memory market) private view {
        if (candidate.agent != mandate.agent) revert AgentMismatch();
        if (candidate.side != mandate.side) revert SideMismatch();

        bytes32 mandateAsset = MandateCodec.assetHash(mandate.canonicalAsset);
        if (MandateCodec.assetHash(candidate.canonicalAsset) != mandateAsset) revert CanonicalAssetMismatch();
        if (market.canonicalAssetHash != mandateAsset) revert RepresentationAssetMismatch();

        if (keccak256(bytes(candidate.chain)) != _CHAIN_HASH) revert ChainMismatch();
        if (!MandateCodec.contains(mandate.allowedChains, _CHAIN_HASH)) revert ChainNotAllowed();

        if (keccak256(bytes(candidate.venue)) != market.venueHash) revert VenueMismatch();
        if (!MandateCodec.contains(mandate.allowedVenues, market.venueHash)) revert VenueNotAllowed();

        if (keccak256(bytes(candidate.issuer)) != market.issuerHash) revert IssuerMismatch();
        if (!MandateCodec.contains(mandate.allowedIssuers, market.issuerHash)) revert IssuerNotAllowed();

        if (market.synthetic && mandate.syntheticPolicy == SYNTHETIC_FORBIDDEN) revert SyntheticNotAllowed();

        if (
            keccak256(bytes(candidate.quantity.unit)) != market.quantityUnitHash
                || candidate.quantity.decimals != market.representationDecimals
        ) revert QuantityUnitMismatch();
        if (candidate.quantity.atoms == 0) revert ZeroQuantity();

        if (keccak256(bytes(mandate.economicLimit.unit)) != market.settlementUnitHash) {
            revert SettlementUnitMismatch();
        }
    }

    function _plan(
        Plan memory plan,
        Mandate calldata mandate,
        Candidate calldata candidate,
        ExecutionTerms calldata terms
    ) private view {
        if (terms.recipient != mandate.principal) revert RecipientNotPrincipal();

        Market memory market = plan.market;
        uint256 quantity = candidate.quantity.atoms;
        plan.exactQuantity = quantity;
        plan.side = mandate.side;
        if (mandate.side == SIDE_BUY) {
            uint256 bound =
                floorToScale(mandate.economicLimit.atoms, mandate.economicLimit.decimals, market.fundingDecimals);
            if (terms.fundingLimit > bound) revert FundingLimitExceedsMandate(terms.fundingLimit, bound);
            plan.inputToken = market.fundingToken;
            plan.outputToken = market.representation;
            plan.inputAmount = terms.fundingLimit;
            plan.minOutput = quantity;
        } else {
            (bool representable, uint256 bound) =
                ceilToScale(mandate.economicLimit.atoms, mandate.economicLimit.decimals, market.fundingDecimals);
            if (!representable) revert FundingLimitBelowMandate(terms.fundingLimit, type(uint256).max);
            if (terms.fundingLimit < bound) revert FundingLimitBelowMandate(terms.fundingLimit, bound);
            plan.inputToken = market.representation;
            plan.outputToken = market.fundingToken;
            plan.inputAmount = quantity;
            plan.minOutput = terms.fundingLimit;
        }

        if (IERC20Metadata(market.representation).decimals() != market.representationDecimals) {
            revert TokenDecimalsChanged(market.representation);
        }
        if (IERC20Metadata(market.fundingToken).decimals() != market.fundingDecimals) {
            revert TokenDecimalsChanged(market.fundingToken);
        }
    }

    function _settle(Plan memory plan, address principal, ExecutionTerms calldata terms)
        private
        returns (uint256 actualDebit, uint256 actualCredit)
    {
        IERC20 input = IERC20(plan.inputToken);
        IERC20 output = IERC20(plan.outputToken);
        address recipient = terms.recipient;

        uint256 inputBefore = input.balanceOf(principal);
        uint256 outputBefore = output.balanceOf(recipient);

        // slither-disable-next-line arbitrary-send-erc20
        input.safeTransferFrom(principal, plan.market.adapter, plan.inputAmount);
        IMandateExecutionAdapter(plan.market.adapter)
            .execute(
                ExecutionOrder({
                    side: plan.side,
                    inputToken: plan.inputToken,
                    outputToken: plan.outputToken,
                    inputAmount: plan.inputAmount,
                    minOutput: plan.minOutput,
                    recipient: recipient,
                    refundTo: principal,
                    executionData: terms.executionData,
                    executionCommitment: plan.executionCommitment
                })
            );

        uint256 inputAfter = input.balanceOf(principal);
        uint256 outputAfter = output.balanceOf(recipient);
        actualDebit = inputBefore > inputAfter ? inputBefore - inputAfter : 0;
        actualCredit = outputAfter > outputBefore ? outputAfter - outputBefore : 0;

        if (plan.side == SIDE_BUY) {
            // slither-disable-next-line reentrancy-balance
            if (actualDebit > plan.inputAmount) revert DebitExceedsLimit(actualDebit, plan.inputAmount);
            // slither-disable-next-line reentrancy-balance
            if (actualCredit != plan.exactQuantity) revert CreditNotExact(actualCredit, plan.exactQuantity);
        } else {
            // slither-disable-next-line reentrancy-balance
            if (actualDebit != plan.exactQuantity) revert DebitNotExact(actualDebit, plan.exactQuantity);
            // slither-disable-next-line reentrancy-balance
            if (actualCredit < plan.minOutput) revert CreditBelowMinimum(actualCredit, plan.minOutput);
        }
    }

    function _signedBy(bytes32 structHash, bytes calldata signature, address signer) private view returns (bool) {
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", _DOMAIN_SEPARATOR, structHash));
        // slither-disable-next-line unused-return
        (address recovered, ECDSA.RecoverError recoverError,) = ECDSA.tryRecover(digest, signature);
        return recoverError == ECDSA.RecoverError.NoError && recovered == signer;
    }

    // ------------------------------------------------------------------
    // Exact unit conversion (same semantics as V2 gate)
    // ------------------------------------------------------------------

    function floorToScale(uint256 atoms, uint8 fromDecimals, uint8 toDecimals) public pure returns (uint256) {
        if (toDecimals >= fromDecimals) {
            uint256 factor = 10 ** uint256(toDecimals - fromDecimals);
            if (atoms > type(uint256).max / factor) return type(uint256).max;
            return atoms * factor;
        }
        return atoms / 10 ** uint256(fromDecimals - toDecimals);
    }

    function ceilToScale(uint256 atoms, uint8 fromDecimals, uint8 toDecimals)
        public
        pure
        returns (bool representable, uint256 scaled)
    {
        if (toDecimals >= fromDecimals) {
            uint256 factor = 10 ** uint256(toDecimals - fromDecimals);
            if (atoms > type(uint256).max / factor) return (false, 0);
            return (true, atoms * factor);
        }
        uint256 divisor = 10 ** uint256(fromDecimals - toDecimals);
        scaled = atoms / divisor;
        if (atoms % divisor != 0) scaled += 1;
        return (true, scaled);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice EIP-712 struct hash of the principal's reusable delegation.
    function delegationDigest(Delegation calldata d) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DELEGATED_PORTFOLIO_AUTHORIZATION_V3_TYPEHASH,
                d.portfolioMandateDigest,
                d.initialAllocationDigest,
                d.sessionDigest,
                d.principal,
                d.delegate,
                d.agent,
                d.representationIdHash,
                d.fundingToken,
                d.cumulativeDebitLimit,
                d.validAfter,
                d.validUntil,
                d.generation
            )
        );
    }

    function usedDebitOf(bytes32 delegationDigest_) external view returns (uint256) {
        return _usedDebit[delegationDigest_];
    }

    function nonceUsed(bytes32 delegationDigest_, uint64 executionNonce) external view returns (bool) {
        return _usedNonce[delegationDigest_][executionNonce];
    }

    function isRevoked(bytes32 delegationDigest_) external view returns (bool) {
        return _revoked[delegationDigest_];
    }

    function marketOf(bytes32 representationIdHash) external view returns (Market memory) {
        return _markets[representationIdHash];
    }

    function fixtureVenueOf(bytes32 representationIdHash) external view returns (address) {
        return _fixtureVenues[representationIdHash];
    }

    function domainSeparator() external view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }
}
