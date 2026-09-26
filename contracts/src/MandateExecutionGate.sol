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

/// @title MandateExecutionGate
/// @notice The onchain half of Mandate: a transaction that materially differs
/// from what was authorized and verified offchain cannot settle through it.
///
/// @dev One entry point, no owner, no upgrade path, no setter. The supported
/// markets are fixed at construction. The gate is not a generic executor: it
/// calls exactly one adapter per market, with exactly one call shape, and it
/// never forwards caller-chosen targets or calldata.
///
/// Every market is a labelled settlement fixture, and the constructor creates
/// that market's `FixtureVenue` and `FixtureVenueAdapter` itself from code
/// compiled into this contract (Phase 6R.1a). No adapter or venue is ever
/// supplied, so which code settles a market, at which price and against which
/// tokens, is a function of this contract's bytecode and its constructor
/// arguments — not of anything a deployed contract reports about itself.
///
/// Authority chain, checked in this order on every call:
///
/// 1. the chain is the deployment chain;
/// 2. the mandate re-encodes (MCE v2) to a digest the *principal* signed under
///    this gate's EIP-712 domain — the same `MandateAuthorization` the offchain
///    kernel verifies (ADR 0001);
/// 3. the candidate re-encodes (Candidate V3) to a digest, and its
///    `representationId` names a supported market;
/// 4. the *agent* named in the mandate signed an `ExecutionAuthorization`
///    committing to both digests and to every execution-specific choice;
/// 5. chain time is inside the mandate's validity window and the agent's
///    deadline;
/// 6. the mandate digest — the kernel's replay key — is unconsumed here;
/// 7. candidate, mandate and pinned market facts agree on agent, side, asset,
///    chain, venue, issuer, synthetic policy, units, recipient and the signed
///    economic bound;
/// 8. the authorization is consumed, *then* the principal's input moves to the
///    adapter and the adapter runs;
/// 9. the principal's measured balance deltas satisfy the bound. Anything else
///    reverts the whole transaction, including step 8's consumption.
///
/// See docs/execution-gate.md for the commitment hierarchy, what is enforced
/// only offchain, and the residual risks.
contract MandateExecutionGate is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_PROFILE_SET_SIZE = 16;
    uint256 public constant MAX_EXECUTION_DATA_BYTES = 4_096;
    uint256 public constant MAX_MARKETS = 32;
    /// @dev `FixtureVenue` refuses a fee of 100% or more; refused here first, as `InvalidMarket`.
    uint256 private constant FIXTURE_FEE_BPS_LIMIT = 10_000;

    // ------------------------------------------------------------------
    // EIP-712
    // ------------------------------------------------------------------

    /// @dev Kernel `EIP712_DOMAIN_TYPE`.
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @dev ADR 0001: `{ name: "Mandate", version: "1", chainId, verifyingContract }`.
    bytes32 private constant NAME_HASH = keccak256("Mandate");
    bytes32 private constant VERSION_HASH = keccak256("1");

    /// @dev Kernel `MANDATE_AUTHORIZATION_TYPE`. Signed by the principal.
    bytes32 public constant MANDATE_AUTHORIZATION_TYPEHASH = keccak256("MandateAuthorization(bytes32 mandateDigest)");

    /// @dev Signed by the agent after offchain handoff verification. Everything
    /// else the gate executes is a function of these fields plus the immutable
    /// market table, so this is the whole execution commitment.
    bytes32 public constant EXECUTION_AUTHORIZATION_TYPEHASH = keccak256(
        "ExecutionAuthorization(bytes32 mandateDigest,bytes32 candidateDigest,address recipient,uint256 fundingLimit,uint64 deadline,bytes executionData)"
    );

    /// @notice The chain this gate was deployed on and will execute on.
    uint256 public immutable CHAIN_ID;

    bytes32 private immutable _DOMAIN_SEPARATOR;
    /// @dev keccak of `eip155:<CHAIN_ID>`, the candidate's required `chain`.
    bytes32 private immutable _CHAIN_HASH;

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    /// @dev Keyed by keccak of the registry's CAIP-19 representation identifier.
    /// Written only by the constructor.
    mapping(bytes32 representationIdHash => Market) private _markets;

    /// @dev The `FixtureVenue` the constructor created for each market. Read only
    /// by `fixtureVenueOf`: execution needs only the adapter, which names it.
    mapping(bytes32 representationIdHash => address venue) private _fixtureVenues;

    /// @dev The final replay authority for gate executions. Keyed by the mandate
    /// digest (the kernel's replay key); the value is the execution commitment
    /// that consumed it. Zero means unconsumed. Only a successful execution
    /// writes it, and a revert anywhere in `execute` unwinds the write.
    mapping(bytes32 mandateDigest => bytes32 executionCommitment) private _executions;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice A market the gate supports, emitted once per market at construction.
    event MarketSupported(
        bytes32 indexed representationIdHash,
        address indexed representation,
        address indexed fundingToken,
        address adapter,
        address fixtureVenue,
        uint256 fixtureVenuePrice,
        string representationId
    );

    /// @notice One authorization settled. This is the chain evidence offchain
    /// reconciliation reads (docs/execution-gate.md §9).
    /// @param actualDebit Measured decrease of the principal's `inputToken` balance.
    /// @param actualCredit Measured increase of the recipient's `outputToken` balance.
    event MandateExecuted(
        bytes32 indexed mandateDigest,
        bytes32 indexed executionCommitment,
        address indexed principal,
        bytes32 candidateDigest,
        address agent,
        address adapter,
        address inputToken,
        address outputToken,
        uint8 side,
        uint256 actualDebit,
        uint256 actualCredit
    );

    // ------------------------------------------------------------------
    // Errors. Order of checks is part of the interface: the TypeScript
    // reference model in packages/execution-gate reproduces it exactly.
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
    error MandateNotYetActive();
    error MandateExpired();
    error ExecutionDeadlinePassed();
    error MandateAlreadyConsumed();
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

    // ------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------

    /// @param markets The complete, permanent set of supported markets.
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

        // Constructor only, over a deployer-chosen market list: a token whose
        // `decimals()` reverts fails the deployment, which is the right outcome.
        // slither-disable-next-line calls-loop
        uint8 representationDecimals = IERC20Metadata(config.representation).decimals();
        // slither-disable-next-line calls-loop
        uint8 fundingDecimals = IERC20Metadata(config.fundingToken).decimals();
        // Beyond the kernel's decimal range no signed amount can be compared exactly.
        if (representationDecimals > MandateCodec.MAX_DECIMALS || fundingDecimals > MandateCodec.MAX_DECIMALS) {
            revert InvalidMarket();
        }

        // The key is derived, not supplied, so a market cannot be registered
        // under an identifier that names a different contract.
        string memory representationId = MandateCodec.representationId(block.chainid, config.representation);
        bytes32 key = keccak256(bytes(representationId));
        if (_markets[key].representation != address(0)) revert InvalidMarket();

        // One price, written once. The venue charges funding-token atoms per
        // whole token; `atoms / 10^decimals` settlement units per whole token is
        // exactly that many funding atoms over `10^fundingDecimals`, the declared
        // funding assumption (docs §6). A typed price finer than the funding
        // token can express has no exact venue price and is refused.
        (bool representable, uint256 venuePrice) =
            _fundingAtomsPerToken(config.fixturePrice.atoms, config.fixturePrice.decimals, fundingDecimals);
        if (!representable) revert FixturePriceNotRepresentable();

        // The venue and adapter are created here, from code compiled into this
        // contract, wired to this market's tokens, this price and this gate.
        // Nothing is read back from them: their behaviour is their bytecode. The
        // venue takes the decimals pinned above rather than asking the tokens
        // again, so the gate and its venue cannot hold different units.
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

    /// @dev `atoms / 10^priceDecimals` whole funding units, in funding atoms, exactly.
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
    // Execution
    // ------------------------------------------------------------------

    /// @dev Everything resolved before any state changes or external call.
    struct Plan {
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
    }

    /// @notice Execute one supported action under one principal-signed mandate
    /// and one agent-signed execution authorization.
    /// @return executionCommitment The commitment now recorded against the mandate digest.
    /// @return actualDebit Measured decrease of the principal's input-token balance.
    /// @return actualCredit Measured increase of the recipient's output-token balance.
    function execute(
        Mandate calldata mandate,
        bytes calldata principalSignature,
        Candidate calldata candidate,
        ExecutionTerms calldata terms,
        bytes calldata agentSignature
    ) external nonReentrant returns (bytes32 executionCommitment, uint256 actualDebit, uint256 actualCredit) {
        Plan memory plan = _authorize(mandate, principalSignature, candidate, terms, agentSignature);

        // Effects before interactions: the authorization is consumed before any
        // token or adapter code runs, so no callback can observe it unconsumed.
        // If anything below reverts, EVM atomicity unwinds this write too.
        _executions[plan.mandateDigest] = plan.executionCommitment;

        (actualDebit, actualCredit) = _settle(plan, mandate.principal, terms);

        emit MandateExecuted(
            plan.mandateDigest,
            plan.executionCommitment,
            mandate.principal,
            plan.candidateDigest,
            mandate.agent,
            plan.market.adapter,
            plan.inputToken,
            plan.outputToken,
            plan.side,
            actualDebit,
            actualCredit
        );
        return (plan.executionCommitment, actualDebit, actualCredit);
    }

    function _authorize(
        Mandate calldata mandate,
        bytes calldata principalSignature,
        Candidate calldata candidate,
        ExecutionTerms calldata terms,
        bytes calldata agentSignature
    ) private view returns (Plan memory plan) {
        if (block.chainid != CHAIN_ID) revert WrongChain();

        MandateCodec.Validity validity = MandateCodec.validateMandate(mandate);
        if (validity == MandateCodec.Validity.UNSUPPORTED_VERSION) revert UnsupportedMandateVersion();
        if (validity != MandateCodec.Validity.VALID) revert MalformedMandate();
        if (
            mandate.allowedIssuers.length > MAX_PROFILE_SET_SIZE || mandate.allowedChains.length > MAX_PROFILE_SET_SIZE
                || mandate.allowedVenues.length > MAX_PROFILE_SET_SIZE
        ) revert ExecutionProfileExceeded();
        plan.mandateDigest = MandateCodec.mandateDigest(mandate);

        bytes32 mandateStruct = keccak256(abi.encode(MANDATE_AUTHORIZATION_TYPEHASH, plan.mandateDigest));
        if (!_signedBy(mandateStruct, principalSignature, mandate.principal)) revert PrincipalSignatureInvalid();

        if (!MandateCodec.isValidCandidate(candidate)) revert MalformedCandidate();
        if (terms.executionData.length > MAX_EXECUTION_DATA_BYTES) revert ExecutionProfileExceeded();
        plan.candidateDigest = MandateCodec.candidateDigest(candidate);

        plan.market = _markets[keccak256(bytes(candidate.representationId))];
        if (plan.market.representation == address(0)) revert UnsupportedRepresentation();

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

        _checkTime(mandate, terms);
        if (_executions[plan.mandateDigest] != bytes32(0)) revert MandateAlreadyConsumed();
        _checkBinding(mandate, candidate, plan.market);
        _checkEconomics(mandate, candidate, plan.market);
        _plan(plan, mandate, candidate, terms);
    }

    /// @dev Exact overlap with the kernel's static notional and declared
    /// economic checks. The candidate is agent-authored, so its arithmetic is
    /// independently established before any quantity can become an input amount.
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
            if (!GateArithmetic.differenceMeetsLimit(
                    candidate.notional.atoms,
                    candidate.notional.decimals,
                    candidate.feeTotal.atoms,
                    candidate.feeTotal.decimals,
                    mandate.economicLimit.atoms,
                    mandate.economicLimit.decimals
                )) revert DeclaredTotalCreditBelowMinimum();
        }
    }

    /// @dev Principal `maxNotional` bounds the true gross, not the agent's rendering
    /// of it (Phase 6R.1, M-1). The declared notional is compared first, as
    /// before; then quantity x the immutable fixture price is rendered at the
    /// principal's own precision and rounded up. The declared notional's
    /// precision is the agent's choice, and at a coarse one it can sit almost a
    /// whole unit below the true product, so only the product comparison binds.
    /// The ceiling exceeds the integer bound exactly when the product does; a
    /// product beyond uint256 at that scale exceeds any bound.
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
        // The floor is not needed: the ceiling alone is the exact criterion.
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

    /// @dev Chain time is the only clock. The window matches the kernel's
    /// `checkValidityWindow` exactly: live on `notBefore`, expired *on*
    /// `expiresAt`. The agent's deadline is inclusive. Using `block.timestamp`
    /// here is the point of Phase 6 (INV-10), not an oversight (docs §14, S-6).
    // slither-disable-next-line timestamp
    function _checkTime(Mandate calldata mandate, ExecutionTerms calldata terms) private view {
        // block.timestamp is far below 2^255, so the signed widening is exact.
        int256 nowSeconds = int256(block.timestamp);
        if (nowSeconds < int256(mandate.notBeforeUnixSeconds)) revert MandateNotYetActive();
        if (nowSeconds >= int256(mandate.expiresAtUnixSeconds)) revert MandateExpired();
        // Chain time is the intended authority here (INV-10). A sequencer can
        // skew it only within the chain's timestamp bounds; docs §12 records that.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > terms.deadline) revert ExecutionDeadlinePassed();
    }

    /// @dev The subset of the kernel's pure candidate-versus-mandate checks the
    /// chain can re-establish, plus the pinned registry facts that turn a
    /// representation identifier into an asset, an issuer and a venue. A flat
    /// list of independent checks in interface order; splitting it would hide
    /// the order the reference model reproduces.
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

    /// @dev Resolves the concrete order and checks the agent's funding limit
    /// against the principal's signed bound, converted to funding-token atoms
    /// with rounding that always favours the principal.
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
            // MAX_TOTAL_DEBIT: round the bound down. A bound beyond uint256 is
            // unreachable by any debit, so saturating is exact, not lenient.
            uint256 bound =
                floorToScale(mandate.economicLimit.atoms, mandate.economicLimit.decimals, market.fundingDecimals);
            if (terms.fundingLimit > bound) revert FundingLimitExceedsMandate(terms.fundingLimit, bound);
            plan.inputToken = market.fundingToken;
            plan.outputToken = market.representation;
            plan.inputAmount = terms.fundingLimit;
            plan.minOutput = quantity;
        } else {
            // MIN_TOTAL_CREDIT: round the bound up. A bound beyond uint256 is a
            // credit nothing can deliver, so it refuses.
            (bool representable, uint256 bound) =
                ceilToScale(mandate.economicLimit.atoms, mandate.economicLimit.decimals, market.fundingDecimals);
            if (!representable) revert FundingLimitBelowMandate(terms.fundingLimit, type(uint256).max);
            if (terms.fundingLimit < bound) revert FundingLimitBelowMandate(terms.fundingLimit, bound);
            plan.inputToken = market.representation;
            plan.outputToken = market.fundingToken;
            plan.inputAmount = quantity;
            plan.minOutput = terms.fundingLimit;
        }

        // The pinned decimals are what made the comparisons above exact. A token
        // whose decimals moved since deployment no longer means those numbers.
        if (IERC20Metadata(market.representation).decimals() != market.representationDecimals) {
            revert TokenDecimalsChanged(market.representation);
        }
        if (IERC20Metadata(market.fundingToken).decimals() != market.fundingDecimals) {
            revert TokenDecimalsChanged(market.fundingToken);
        }
    }

    /// @dev Moves exactly `inputAmount` from the principal to the adapter, runs
    /// the adapter, and settles on measured balances. The gate itself never holds
    /// funds and never grants an allowance.
    function _settle(Plan memory plan, address principal, ExecutionTerms calldata terms)
        private
        returns (uint256 actualDebit, uint256 actualCredit)
    {
        IERC20 input = IERC20(plan.inputToken);
        IERC20 output = IERC20(plan.outputToken);
        address recipient = terms.recipient;

        // Pre-call balances are pre-call on purpose: settlement is the net delta
        // across the whole interaction, whatever the adapter or venue did in
        // between. Re-entry into the gate is blocked by `nonReentrant` (docs §14, S-2).
        uint256 inputBefore = input.balanceOf(principal);
        uint256 outputBefore = output.balanceOf(recipient);

        // `principal` is not arbitrary: `_authorize` has verified the principal's
        // EIP-712 signature over this mandate's digest under this gate's domain,
        // and bounded `inputAmount` by that signed mandate (docs §14, S-1).
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
            // Strict FILL_OR_KILL: unsolicited extra output fails closed too.
            // slither-disable-next-line reentrancy-balance
            if (actualCredit != plan.exactQuantity) revert CreditNotExact(actualCredit, plan.exactQuantity);
        } else {
            // Strict FILL_OR_KILL: every candidate representation atom is sold.
            // slither-disable-next-line reentrancy-balance
            if (actualDebit != plan.exactQuantity) revert DebitNotExact(actualDebit, plan.exactQuantity);
            // slither-disable-next-line reentrancy-balance
            if (actualCredit < plan.minOutput) revert CreditBelowMinimum(actualCredit, plan.minOutput);
        }
    }

    /// @dev ECDSA recovery with the kernel's acceptance rule: exactly 65 bytes,
    /// `v` in {27, 28}, low `s`, recovered signer equal to the named party.
    function _signedBy(bytes32 structHash, bytes calldata signature, address signer) private view returns (bool) {
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", _DOMAIN_SEPARATOR, structHash));
        // The third value only describes *why* recovery failed; the error enum decides.
        // slither-disable-next-line unused-return
        (address recovered, ECDSA.RecoverError recoverError,) = ECDSA.tryRecover(digest, signature);
        return recoverError == ECDSA.RecoverError.NoError && recovered == signer;
    }

    // ------------------------------------------------------------------
    // Exact unit conversion
    // ------------------------------------------------------------------

    /// @notice `atoms * 10^to / 10^from`, rounded toward zero, saturating at
    /// `type(uint256).max`.
    function floorToScale(uint256 atoms, uint8 fromDecimals, uint8 toDecimals) public pure returns (uint256) {
        if (toDecimals >= fromDecimals) {
            uint256 factor = 10 ** uint256(toDecimals - fromDecimals);
            if (atoms > type(uint256).max / factor) return type(uint256).max;
            return atoms * factor;
        }
        return atoms / 10 ** uint256(fromDecimals - toDecimals);
    }

    /// @notice `atoms * 10^to / 10^from`, rounded away from zero.
    /// @return representable False when the result exceeds `uint256`.
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
    // Views for reconciliation
    // ------------------------------------------------------------------

    /// @notice The execution commitment that consumed `mandateDigest`, or zero.
    /// @dev Non-zero means exactly one gate execution of this authorization
    /// settled, in a transaction that did not revert.
    function executionCommitmentOf(bytes32 mandateDigest) external view returns (bytes32) {
        return _executions[mandateDigest];
    }

    /// @notice The supported market for a representation identifier hash.
    function marketOf(bytes32 representationIdHash) external view returns (Market memory) {
        return _markets[representationIdHash];
    }

    /// @notice The `FixtureVenue` this gate created for a market, or zero.
    function fixtureVenueOf(bytes32 representationIdHash) external view returns (address) {
        return _fixtureVenues[representationIdHash];
    }

    /// @notice This gate's EIP-712 domain separator (ADR 0001 domain, this chain, this address).
    function domainSeparator() external view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }
}
