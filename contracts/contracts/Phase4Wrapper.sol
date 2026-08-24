// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface IPhase4WrapperVerifier {
    function governance() external view returns (address);
    function reserveOperation(bytes32 operationId) external;
    function registerBurnProof(bytes32, uint256, bytes32, uint256, uint256, address, address, address, address, bytes32, bytes32) external;
    function bindBurnProofEvent(bytes32, bytes32, uint256) external;
    function consumeLockProof(bytes32, bytes32, address, address, bytes32, uint256, uint256, address, address, bytes32, uint256) external;
    function consumeLockProofEvent(bytes32, bytes32, uint256) external;
    function cancelBurnProof(bytes32 operationId) external;
    function burnProofRecoverable(bytes32 operationId) external view returns (bool);
    function attestationDigest(bytes32, bytes32, address, address, bytes32, uint256, uint256, address, address, bytes32, uint256) external view returns (bytes32);
    function verify(bytes32 digest, bytes[] calldata signatures) external view returns (bool);
    function consumeLimit(uint256 amount) external;
}
interface IPhase4EscrowAccounting { function lockedAccounting() external view returns (uint256); }

contract Phase4Wrapper is ERC20, Ownable, Pausable {
    struct BridgeMessage { bytes32 sourceDomain; bytes32 destinationDomain; address canonicalToken; address wrapper; bytes32 operationId; uint256 nonce; uint256 amount; address sender; address recipient; bytes32 sourceBlockHash; uint256 expiry; }
    struct BurnRecord { address sender; address recipient; uint256 amount; bool exists; }
    IPhase4WrapperVerifier public immutable verifier;
    bytes32 public immutable sourceDomain;
    bytes32 public immutable destinationDomain;
    address public immutable canonicalToken;
    address public immutable remoteEscrow;
    uint256 public lastNonce;
    uint256 public mintedAccounting;
    uint256 public burnedAccounting;
    mapping(bytes32 => bool) public consumed;
    mapping(bytes32 => bool) public burnConsumed;
    mapping(bytes32 => BurnRecord) public burns;
    enum OperationState { None, Initiated, SourceFinalized, MessageAttested, DestinationExecuted, Completed, Failed, Refundable, Refunded }
    mapping(bytes32 => OperationState) public operationState;
    mapping(bytes32 => bool) public burnRecovered;
    event BridgeMinted(bytes32 indexed operationId, address indexed recipient, uint256 amount);
    event Burned(bytes32 indexed operationId, address indexed sender, address indexed recipient, uint256 amount);
    event BurnRecovered(bytes32 indexed operationId, address indexed sender, uint256 amount);

    constructor(string memory name_, string memory symbol_, address verifier_, bytes32 sourceDomain_, bytes32 destinationDomain_, address canonicalToken_, address remoteEscrow_) ERC20(name_, symbol_) Ownable(msg.sender) {
        require(verifier_ != address(0) && canonicalToken_ != address(0) && remoteEscrow_ != address(0) && sourceDomain_ != bytes32(0) && destinationDomain_ != bytes32(0), "zero-address");
        verifier = IPhase4WrapperVerifier(verifier_); sourceDomain = sourceDomain_; destinationDomain = destinationDomain_; canonicalToken = canonicalToken_; remoteEscrow = remoteEscrow_;
    }
    function decimals() public pure override returns (uint8) { return 8; }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
    function _validateProof(BridgeMessage calldata message) private {
        verifier.consumeLockProof(
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
    function mintFromLock(BridgeMessage calldata message, bytes[] calldata signatures) external whenNotPaused {
        _mintFromLock(message, signatures, bytes32(0), 0);
    }
    function mintFromLock(BridgeMessage calldata message, bytes[] calldata signatures, bytes32 eventTxHash, uint256 eventLogIndex) external whenNotPaused {
        _mintFromLock(message, signatures, eventTxHash, eventLogIndex);
    }
    function _mintFromLock(BridgeMessage calldata message, bytes[] calldata signatures, bytes32 eventTxHash, uint256 eventLogIndex) internal {
        require(message.sourceDomain == sourceDomain, "wrong-source-domain"); require(message.destinationDomain == destinationDomain, "wrong-destination-domain"); require(message.canonicalToken == canonicalToken, "wrong-canonical-token"); require(message.wrapper == address(this), "wrong-wrapper");
        require(message.amount > 0 && message.sender != address(0) && message.recipient != address(0) && message.operationId != bytes32(0) && message.sourceBlockHash != bytes32(0), "invalid-mint");
        require(message.expiry >= block.timestamp, "attestation-expired"); require(!consumed[message.operationId], "operation-consumed"); require(message.nonce > lastNonce, "nonce-not-monotonic");
        require(IPhase4EscrowAccounting(remoteEscrow).lockedAccounting() >= totalSupply() + message.amount, "escrow-insolvent");
        bytes32 digest = _messageDigest(message);
        require(verifier.verify(digest, signatures), "invalid-attestation");
        _validateProof(message);
        verifier.consumeLockProofEvent(message.operationId, eventTxHash, eventLogIndex);
        verifier.consumeLimit(message.amount);
        consumed[message.operationId] = true; lastNonce = message.nonce; mintedAccounting += message.amount; _mint(message.recipient, message.amount); operationState[message.operationId] = OperationState.Completed; require(mintedAccounting - burnedAccounting == totalSupply(), "wrapper-accounting-broken"); emit BridgeMinted(message.operationId, message.recipient, message.amount);
    }
    function burnAndRelease(uint256 amount, address recipient, bytes32 operationId) external whenNotPaused {
        require(amount > 0 && recipient != address(0) && operationId != bytes32(0), "invalid-burn"); require(!burnConsumed[operationId], "operation-consumed");
        verifier.reserveOperation(operationId);
        burnConsumed[operationId] = true; burns[operationId] = BurnRecord(msg.sender, recipient, amount, true); operationState[operationId] = OperationState.Initiated; _burn(msg.sender, amount); burnedAccounting += amount; require(mintedAccounting - burnedAccounting == totalSupply(), "wrapper-accounting-broken"); emit Burned(operationId, msg.sender, recipient, amount);
    }
    function recoverBurn(bytes32 operationId) external whenNotPaused {
        BurnRecord memory record = burns[operationId];
        require(record.exists, "burn-not-found");
        require(!burnRecovered[operationId], "burn-already-recovered");
        require(verifier.burnProofRecoverable(operationId), "burn-not-recoverable");
        verifier.cancelBurnProof(operationId);
        burnRecovered[operationId] = true;
        operationState[operationId] = OperationState.Refunded;
        mintedAccounting += record.amount;
        _mint(record.sender, record.amount);
        require(mintedAccounting - burnedAccounting == totalSupply(), "wrapper-accounting-broken");
        emit BurnRecovered(operationId, record.sender, record.amount);
    }
    function registerBurnProofWithEvent(bytes32 operationId, uint256 nonce, bytes32 sourceBlockHash, uint256 expiry, bytes32 eventTxHash, uint256 eventLogIndex) external onlyOwner {
        BurnRecord memory record = burns[operationId]; require(record.exists, "burn-not-found");
        verifier.registerBurnProof(operationId, nonce, sourceBlockHash, expiry, record.amount, record.sender, record.recipient, canonicalToken, address(this), destinationDomain, sourceDomain);
        verifier.bindBurnProofEvent(operationId, eventTxHash, eventLogIndex);
        operationState[operationId] = OperationState.SourceFinalized;
    }

    function wrapperSupply() external view returns (uint256) { return totalSupply(); }
    function isReconciled() public view returns (bool) { return mintedAccounting >= burnedAccounting && mintedAccounting - burnedAccounting == totalSupply(); }
    function assertReconciled() external view { require(isReconciled(), "wrapper-accounting-broken"); }
    function registerBurnProof(bytes32 operationId, uint256 nonce, bytes32 sourceBlockHash, uint256 expiry) external onlyOwner {
        BurnRecord memory record = burns[operationId]; require(record.exists, "burn-not-found");
        verifier.registerBurnProof(operationId, nonce, sourceBlockHash, expiry, record.amount, record.sender, record.recipient, canonicalToken, address(this), destinationDomain, sourceDomain);
        operationState[operationId] = OperationState.SourceFinalized;
    }
}
