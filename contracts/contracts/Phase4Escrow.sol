// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface IPhase4Verifier {
    function governance() external view returns (address);
    function setLockDomains(bytes32 sourceDomain, bytes32 destinationDomain) external;
    function reserveOperation(bytes32 operationId) external;
    function registerLockProof(bytes32, uint256, bytes32, uint256, uint256, address, address, address, address) external;
    function bindLockProofEvent(bytes32, bytes32, uint256) external;
    function consumeLockProofEvent(bytes32, bytes32, uint256) external;
    function consumeBurnProof(bytes32, bytes32, address, address, bytes32, uint256, uint256, address, address, bytes32, uint256) external;
    function consumeBurnProofEvent(bytes32, bytes32, uint256) external;
    function cancelLockProof(bytes32 operationId) external;
    function lockProofRecoverable(bytes32 operationId) external view returns (bool);
    function attestationDigest(bytes32, bytes32, address, address, bytes32, uint256, uint256, address, address, bytes32, uint256) external view returns (bytes32);
    function verify(bytes32 digest, bytes[] calldata signatures) external view returns (bool);
    function consumeLimit(uint256 amount) external;
}
interface IPhase4WrapperSupply { function totalSupply() external view returns (uint256); }

contract Phase4Escrow is Ownable, Pausable {
    using SafeERC20 for IERC20;
    struct BridgeMessage { bytes32 sourceDomain; bytes32 destinationDomain; address canonicalToken; address wrapper; bytes32 operationId; uint256 nonce; uint256 amount; address sender; address recipient; bytes32 sourceBlockHash; uint256 expiry; }
    struct LockRecord { address sender; address recipient; uint256 amount; bool exists; }
    IERC20 public immutable canonicalToken;
    IPhase4Verifier public immutable verifier;
    bytes32 public immutable sourceDomain;
    bytes32 public immutable destinationDomain;
    address public remoteWrapper;
    uint256 public lastNonce;
    uint256 public lockedAccounting;
    mapping(bytes32 => bool) public consumed;
    mapping(bytes32 => LockRecord) public locks;
    enum OperationState { None, Initiated, SourceFinalized, MessageAttested, DestinationExecuted, Completed, Failed, Refundable, Refunded }
    mapping(bytes32 => OperationState) public operationState;
    event Locked(bytes32 indexed operationId, address indexed sender, address indexed recipient, uint256 amount);
    event BridgeReleased(bytes32 indexed operationId, address indexed recipient, uint256 amount);
    event LockRefunded(bytes32 indexed operationId, address indexed sender, uint256 amount);
    event RemoteWrapperSet(address indexed wrapper);

    constructor(address token_, address verifier_, bytes32 sourceDomain_, bytes32 destinationDomain_) Ownable(msg.sender) {
        require(token_ != address(0) && verifier_ != address(0) && sourceDomain_ != bytes32(0) && destinationDomain_ != bytes32(0), "zero-address");
        canonicalToken = IERC20(token_); verifier = IPhase4Verifier(verifier_); sourceDomain = sourceDomain_; destinationDomain = destinationDomain_;
        verifier.setLockDomains(sourceDomain_, destinationDomain_);
    }
    function setRemoteWrapper(address wrapper_) external onlyOwner { require(wrapper_ != address(0), "zero-wrapper"); remoteWrapper = wrapper_; emit RemoteWrapperSet(wrapper_); }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
    function lock(uint256 amount, address recipient, bytes32 operationId) external whenNotPaused {
        require(amount > 0 && recipient != address(0) && operationId != bytes32(0), "invalid-lock");
        require(!consumed[operationId], "operation-consumed");
        verifier.reserveOperation(operationId);
        consumed[operationId] = true; locks[operationId] = LockRecord(msg.sender, recipient, amount, true); operationState[operationId] = OperationState.Initiated; lockedAccounting += amount;
        canonicalToken.safeTransferFrom(msg.sender, address(this), amount); emit Locked(operationId, msg.sender, recipient, amount);
    }
    function registerLockProof(bytes32 operationId, uint256 nonce, bytes32 sourceBlockHash, uint256 expiry) external onlyOwner {
        LockRecord memory record = locks[operationId]; require(record.exists, "lock-not-found");
        verifier.registerLockProof(operationId, nonce, sourceBlockHash, expiry, record.amount, record.sender, record.recipient, address(canonicalToken), remoteWrapper);
        operationState[operationId] = OperationState.SourceFinalized;
    }
    function registerLockProofWithEvent(bytes32 operationId, uint256 nonce, bytes32 sourceBlockHash, uint256 expiry, bytes32 eventTxHash, uint256 eventLogIndex) external onlyOwner {
        LockRecord memory record = locks[operationId]; require(record.exists, "lock-not-found");
        verifier.registerLockProof(operationId, nonce, sourceBlockHash, expiry, record.amount, record.sender, record.recipient, address(canonicalToken), remoteWrapper);
        verifier.bindLockProofEvent(operationId, eventTxHash, eventLogIndex);
        operationState[operationId] = OperationState.SourceFinalized;
    }

    function refundLock(bytes32 operationId, address recipient) external whenNotPaused {
        LockRecord memory record = locks[operationId];
        require(record.exists, "lock-not-found");
        require(recipient == record.recipient, "recipient-mismatch");
        require(operationState[operationId] != OperationState.Refunded, "operation-refunded");
        require(verifier.lockProofRecoverable(operationId), "lock-not-refundable");
        verifier.cancelLockProof(operationId);
        require(lockedAccounting >= record.amount && canonicalToken.balanceOf(address(this)) >= record.amount, "escrow-insolvent");
        lockedAccounting -= record.amount;
        operationState[operationId] = OperationState.Refunded;
        canonicalToken.safeTransfer(record.sender, record.amount);
        emit LockRefunded(operationId, record.sender, record.amount);
    }
    function releaseFromBurn(BridgeMessage calldata message, bytes[] calldata signatures) external whenNotPaused {
        _releaseFromBurn(message, signatures, bytes32(0), 0);
    }
    function releaseFromBurn(BridgeMessage calldata message, bytes[] calldata signatures, bytes32 eventTxHash, uint256 eventLogIndex) external whenNotPaused {
        _releaseFromBurn(message, signatures, eventTxHash, eventLogIndex);
    }
    function _releaseFromBurn(BridgeMessage calldata message, bytes[] calldata signatures, bytes32 eventTxHash, uint256 eventLogIndex) internal {
        require(message.sourceDomain == destinationDomain, "wrong-source-domain"); require(message.destinationDomain == sourceDomain, "wrong-destination-domain");
        require(message.canonicalToken == address(canonicalToken), "wrong-canonical-token"); require(message.wrapper == remoteWrapper, "wrong-wrapper");
        require(message.amount > 0 && message.sender != address(0) && message.recipient != address(0) && message.operationId != bytes32(0) && message.sourceBlockHash != bytes32(0), "invalid-release");
        require(message.expiry >= block.timestamp, "attestation-expired"); require(!consumed[message.operationId], "operation-consumed"); require(message.nonce > lastNonce, "nonce-not-monotonic");
        bytes32 digest = _messageDigest(message);
        require(verifier.verify(digest, signatures), "invalid-attestation");
        _validateBurnProof(message);
        verifier.consumeBurnProofEvent(message.operationId, eventTxHash, eventLogIndex);
        verifier.consumeLimit(message.amount);
        require(lockedAccounting >= message.amount && canonicalToken.balanceOf(address(this)) >= message.amount, "escrow-insolvent");
        consumed[message.operationId] = true; lastNonce = message.nonce; lockedAccounting -= message.amount; canonicalToken.safeTransfer(message.recipient, message.amount); emit BridgeReleased(message.operationId, message.recipient, message.amount);
    }
    function _validateBurnProof(BridgeMessage calldata message) private {
        verifier.consumeBurnProof(
            message.sourceDomain, message.destinationDomain, message.canonicalToken, message.wrapper,
            message.operationId, message.nonce, message.amount, message.sender, message.recipient,
            message.sourceBlockHash, message.expiry
        );
    }

    function _messageDigest(BridgeMessage calldata message) private view returns (bytes32) {
        return verifier.attestationDigest(
            message.sourceDomain, message.destinationDomain, message.canonicalToken, message.wrapper,
            message.operationId, message.nonce, message.amount, message.sender, message.recipient,
            message.sourceBlockHash, message.expiry
        );
    }
    function escrowBacking() public view returns (uint256) { return canonicalToken.balanceOf(address(this)); }
    function outstandingLiabilities() external view returns (uint256) {
        uint256 wrapperSupply = remoteWrapper == address(0) ? 0 : IPhase4WrapperSupply(remoteWrapper).totalSupply();
        return lockedAccounting >= wrapperSupply ? lockedAccounting - wrapperSupply : 0;
    }
    function isReconciled() public view returns (bool) {
        if (escrowBacking() != lockedAccounting || remoteWrapper == address(0)) return false;
        return IPhase4WrapperSupply(remoteWrapper).totalSupply() <= lockedAccounting;
    }
    function assertReconciled() external view { require(isReconciled(), "escrow-accounting-broken"); }
}
