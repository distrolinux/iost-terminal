// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

interface IPhase4Factory { function getPair(address tokenA, address tokenB) external view returns (address); }
interface IPhase4Router { function factory() external view returns (address); }
interface IPhase4Pair { function token0() external view returns (address); function token1() external view returns (address); function getReserves() external view returns (uint112, uint112, uint32); }
interface IPhase4Decimals { function decimals() external view returns (uint8); }
interface IPhase4LPBalance { function balanceOf(address account) external view returns (uint256); }

/// @dev Hardhat-local verification and custody fixture. It never performs a
/// swap, deployment, liquidity add, public RPC call, or release-gate change.
contract Phase4DexHarness {
    bytes32 private constant BOOTSTRAP_EVENT_SIGNATURE = keccak256("BootstrapVerified(address,bytes32,uint256,uint256,bytes32,bytes32)");

    address public immutable approvedFactory;
    address public immutable approvedRouter;
    address public immutable approvedWrapper;
    address public immutable approvedQuote;
    address public immutable approvedMultisig;
    address public immutable approvedLock;
    address public immutable approvedVerifier;
    bytes32 public approvedPairCodeHash;
    bytes32 public approvedBootstrapEvidenceHash;
    uint8 public immutable wrapperDecimals;
    uint8 public immutable quoteDecimals;
    uint256 public immutable minReserve;
    uint256 public immutable maxReserve;

    bool public dexVerified;
    bool public pairVerified;
    bool public bootstrapEvidenceApproved;
    bool public bootstrapVerified;
    bool public custodyVerified;
    address public verifiedPair;
    bytes32 public verifiedPairCodeHash;
    bytes32 public bootstrapEvidenceCommitment;
    bytes32 public bootstrapReceiptTxHash;
    bytes32 public bootstrapOperationId;
    uint256 public bootstrapReceiptLogIndex;
    uint256 public bootstrapCheckpointNumber;
    bytes32 public bootstrapCheckpointHash;

    event DexVerified(address indexed factory, address indexed router);
    event PairVerified(address indexed pair, address indexed wrapper, address indexed quote);
    event BootstrapVerified(address indexed pair, bytes32 receiptTxHash, uint256 receiptLogIndex, uint256 checkpointNumber, bytes32 operationId, bytes32 evidenceCommitment);
    event CustodyVerified(address indexed lpToken, address indexed custody);

    modifier onlyApprovedVerifier() { require(msg.sender == approvedVerifier, "not-approved-verifier"); _; }

    constructor(
        address factory_, address router_, address wrapper_, address quote_, address multisig_, address lock_,
        uint8 wrapperDecimals_, uint8 quoteDecimals_, uint256 minReserve_, uint256 maxReserve_, address approvedVerifier_
    ) {
        require(factory_ != address(0) && router_ != address(0) && wrapper_ != address(0) && quote_ != address(0), "zero-dex-address");
        require(multisig_ != address(0) && lock_ != address(0) && approvedVerifier_ != address(0), "zero-authority-address");
        require(minReserve_ > 0 && maxReserve_ >= minReserve_, "invalid-reserve-bounds");
        approvedFactory = factory_; approvedRouter = router_; approvedWrapper = wrapper_; approvedQuote = quote_;
        approvedMultisig = multisig_; approvedLock = lock_; approvedVerifier = approvedVerifier_;
        wrapperDecimals = wrapperDecimals_; quoteDecimals = quoteDecimals_; minReserve = minReserve_; maxReserve = maxReserve_;
    }

    function configureApprovedEvidence(bytes32 pairCodeHash, bytes32 receiptCommitment) external onlyApprovedVerifier {
        require(approvedPairCodeHash == bytes32(0) && approvedBootstrapEvidenceHash == bytes32(0), "evidence-already-configured");
        require(pairCodeHash != bytes32(0) && receiptCommitment != bytes32(0), "zero-approved-evidence");
        approvedPairCodeHash = pairCodeHash;
        approvedBootstrapEvidenceHash = receiptCommitment;
    }

    function verifyRouterFactory(address router_) external onlyApprovedVerifier returns (bool) {
        require(router_ == approvedRouter, "router-not-allowlisted");
        require(router_.code.length > 0, "router-no-code");
        address factory = IPhase4Router(router_).factory();
        require(factory == approvedFactory, "router-factory-mismatch");
        require(factory.code.length > 0, "factory-no-code");
        dexVerified = true;
        emit DexVerified(factory, router_);
        return true;
    }

    function verifyPair(address pair_) external onlyApprovedVerifier returns (bool) {
        require(dexVerified, "dex-not-verified");
        require(!pairVerified, "pair-already-verified");
        require(pair_.code.length > 0, "pair-no-code");
        require(pair_.codehash == approvedPairCodeHash, "pair-codehash-mismatch");
        require(IPhase4Factory(approvedFactory).getPair(approvedWrapper, approvedQuote) == pair_, "pair-factory-mismatch");
        require(IPhase4Pair(pair_).token0() == approvedWrapper && IPhase4Pair(pair_).token1() == approvedQuote, "pair-order-mismatch");
        require(IPhase4Decimals(approvedWrapper).decimals() == wrapperDecimals, "wrapper-decimals-mismatch");
        require(IPhase4Decimals(approvedQuote).decimals() == quoteDecimals, "quote-decimals-mismatch");
        (uint112 reserve0, uint112 reserve1,) = IPhase4Pair(pair_).getReserves();
        require(reserve0 >= minReserve && reserve0 <= maxReserve && reserve1 >= minReserve && reserve1 <= maxReserve, "reserve-out-of-bounds");
        pairVerified = true;
        verifiedPair = pair_;
        verifiedPairCodeHash = pair_.codehash;
        emit PairVerified(pair_, approvedWrapper, approvedQuote);
        return true;
    }

    function approveBootstrapEvidence(
        address pair_, bytes32 receiptTxHash, uint256 receiptLogIndex, bytes32 operationId,
        uint256 checkpointNumber, bytes32 checkpointHash
    ) external onlyApprovedVerifier returns (bool) {
        require(pairVerified && pair_ == verifiedPair && pair_.codehash == verifiedPairCodeHash, "pair-not-verified");
        require(checkpointNumber + 1 == block.number, "checkpoint-not-current");
        require(checkpointHash == blockhash(checkpointNumber), "checkpoint-hash-mismatch");
        bytes32 receiptCommitment = keccak256(abi.encode(pair_, receiptTxHash, receiptLogIndex, operationId, BOOTSTRAP_EVENT_SIGNATURE));
        require(receiptCommitment == approvedBootstrapEvidenceHash, "bootstrap-evidence-mismatch");
        require(!bootstrapEvidenceApproved, "bootstrap-evidence-already-approved");
        bootstrapEvidenceApproved = true;
        bootstrapReceiptTxHash = receiptTxHash;
        bootstrapReceiptLogIndex = receiptLogIndex;
        bootstrapOperationId = operationId;
        bootstrapCheckpointNumber = checkpointNumber;
        bootstrapCheckpointHash = checkpointHash;
        return true;
    }

    function verifyBootstrapAmounts(
        uint256 tokenAmount, uint256 quoteAmount, uint256 liquidity, uint256 slippageBps, uint256 deadline
    ) external onlyApprovedVerifier returns (bool) {
        require(pairVerified && bootstrapEvidenceApproved, "bootstrap-evidence-not-approved");
        require(tokenAmount > 0 && quoteAmount > 0 && liquidity > 0, "zero-bootstrap-amount");
        require(slippageBps <= 10_000, "invalid-slippage");
        require(deadline >= block.timestamp, "bootstrap-deadline");
        require(!bootstrapVerified, "bootstrap-already-verified");
        bootstrapVerified = true;
        bootstrapEvidenceCommitment = keccak256(abi.encode(verifiedPair, tokenAmount, quoteAmount, liquidity, bootstrapReceiptTxHash, bootstrapReceiptLogIndex, bootstrapOperationId));
        emit BootstrapVerified(verifiedPair, bootstrapReceiptTxHash, bootstrapReceiptLogIndex, bootstrapCheckpointNumber, bootstrapOperationId, bootstrapEvidenceCommitment);
        return true;
    }

    function verifyCustody(address lpToken, address custody, uint256 lockUntil) external onlyApprovedVerifier returns (bool) {
        require(bootstrapVerified && bootstrapEvidenceCommitment != bytes32(0), "bootstrap-not-verified");
        require(pairVerified && lpToken == verifiedPair && lpToken.codehash == verifiedPairCodeHash, "lp-pair-identity-mismatch");
        require(custody == approvedMultisig || custody == approvedLock, "custody-not-approved");
        require(custody.code.length > 0, "custody-no-code");
        require(lockUntil > block.timestamp, "lock-expired");
        require(IPhase4LPBalance(lpToken).balanceOf(custody) > 0, "lp-not-in-custody");
        custodyVerified = true;
        emit CustodyVerified(lpToken, custody);
        return true;
    }
}

contract Phase4MockFactory is IPhase4Factory {
    mapping(address => mapping(address => address)) private pairs;
    function setPair(address tokenA, address tokenB, address pair) external { pairs[tokenA][tokenB] = pair; pairs[tokenB][tokenA] = pair; }
    function getPair(address tokenA, address tokenB) external view returns (address) { return pairs[tokenA][tokenB]; }
}
contract Phase4MockRouter is IPhase4Router { address public immutable factory; constructor(address factory_) { factory = factory_; } }
contract Phase4MockDecimalsToken { uint8 public immutable decimals; constructor(uint8 decimals_) { decimals = decimals_; } }
contract Phase4MockCustody {}
contract Phase4MockPair {
    address public immutable token0; address public immutable token1; uint112 private reserve0; uint112 private reserve1; mapping(address => uint256) public balanceOf;
    constructor(address token0_, address token1_, uint112 reserve0_, uint112 reserve1_) { token0 = token0_; token1 = token1_; reserve0 = reserve0_; reserve1 = reserve1_; }
    function getReserves() external view returns (uint112, uint112, uint32) { return (reserve0, reserve1, uint32(block.timestamp)); }
    function seed(address account, uint256 amount) external { balanceOf[account] += amount; }
}
