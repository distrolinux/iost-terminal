// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Phase4GovernanceFactory} from "./Phase4GovernanceFactory.sol";

interface IPhase4GovernanceFactory {
    function isCanonicalGovernance(address governance) external view returns (bool);
}

/// @dev Local-only source-event/finality harness. Finalization is manually asserted on Hardhat;
/// it is not a chain oracle, reorg detector, or production bridge security mechanism.
contract Phase4AttestationVerifier {
    using ECDSA for bytes32;

    address public immutable governanceFactory;

    bytes32 private constant TYPE_HASH = keccak256(
        "BridgeMessage(bytes32 sourceDomain,bytes32 destinationDomain,address canonicalToken,address wrapper,bytes32 operationId,uint256 nonce,uint256 amount,address sender,address recipient,bytes32 sourceBlockHash,uint256 expiry)"
    );

    struct SourceProof {
        bytes32 sourceDomain;
        bytes32 destinationDomain;
        address canonicalToken;
        address wrapper;
        bytes32 operationId;
        uint256 nonce;
        uint256 amount;
        address sender;
        address recipient;
        bytes32 sourceBlockHash;
        uint256 expiry;
        bytes32 eventTxHash;
        uint256 eventLogIndex;
        bool registered;
        bool finalized;
        bool consumed;
    }

    struct EventIdentity { bytes32 txHash; uint256 logIndex; }

    struct EventBinding {
        bytes32 operationId;
        address emitter;
        bytes32 eventSignature;
        bytes32 txHash;
        uint256 logIndex;
        uint256 sourceBlockNumber;
        bytes32 sourceBlockHash;
        uint256 amount;
        address recipient;
        bool registered;
    }

    struct SourceHeader { uint256 number; bytes32 hash; bytes32 parentHash; bytes32 stateRoot; bool registered; }

    address[] private _signers;
    mapping(address => bool) public isSigner;
    uint256 public immutable quorum;
    address public immutable owner;
    address public escrowSource;
    address public wrapperSource;
    mapping(bytes32 => SourceProof) private lockProofs;
    mapping(bytes32 => SourceProof) private burnProofs;
    mapping(bytes32 => uint256) public finalizedBlockNumber;
    mapping(bytes32 => bytes32) public finalizedBlockHash;
    mapping(bytes32 => bytes32) public finalizedBlockRoot;
    mapping(bytes32 => bool) public invalidatedProofs;
    mapping(bytes32 => bool) public failedLockProofs;
    mapping(bytes32 => bool) public failedBurnProofs;
    // Local-only global operation guard: 1 = lock/mint, 2 = burn/release.
    mapping(bytes32 => uint8) public operationRegistry;
    bytes32 public protocolIdentifier = keccak256("AITT-PHASE4-LOCAL");
    uint256 public messageVersion = 1;
    uint256 public sourceChainId;
    uint256 public destinationChainId;
    address public governance;
    uint256 public maxMessageAmount;
    uint256 public maxDailyAmount;
    uint256 public dailyWindow = 1 days;
    uint256 public dailyWindowStart;
    uint256 public dailyAmountUsed;
    bool public bindingActive;
    bool public finalityConfigured;
    uint256 public observerQuorum;
    uint256 public staleHeadDepth;
    uint256 public canonicalHeadNumber;
    bytes32 public canonicalHeadHash;
    bytes32 public canonicalHeadRoot;
    mapping(address => SourceHeader) public observerHeaders;
    mapping(bytes32 => mapping(address => bool)) public sourceEventObservers;
    mapping(bytes32 => EventBinding) public eventBindings;
    mapping(bytes32 => bytes32) public eventBindingCommitments;
    mapping(address => bool) public isObserver;
    address[] private _observers;
    bytes32[] private _proofIds;
    event SourceHeaderRegistered(address indexed observer, uint256 number, bytes32 indexed hash, bytes32 stateRoot);
    event SourceEventRegistered(address indexed observer, bytes32 indexed operationId, uint256 number, bytes32 indexed blockHash);
    event CanonicalHeadReconciled(uint256 number, bytes32 indexed hash, bytes32 stateRoot);
    event SourceProofInvalidated(bytes32 indexed operationId, bytes32 indexed oldBlockHash);

    constructor(address[] memory signers_, uint256 quorum_, address governanceFactory_) {
        require(
            governanceFactory_ != address(0) && governanceFactory_.code.length > 0 &&
            governanceFactory_.codehash == keccak256(type(Phase4GovernanceFactory).runtimeCode),
            "invalid-governance-factory"
        );
        require(signers_.length > 0 && quorum_ > 0 && quorum_ <= signers_.length, "invalid-quorum");
        governanceFactory = governanceFactory_;
        quorum = quorum_;
        owner = msg.sender;
        for (uint256 i; i < signers_.length; ++i) {
            require(signers_[i] != address(0) && !isSigner[signers_[i]], "invalid-signer");
            isSigner[signers_[i]] = true;
            isObserver[signers_[i]] = true;
            _signers.push(signers_[i]);
        }
    }

    function setSourceContracts(address escrow_, address wrapper_) external {
        require(msg.sender == owner, "unauthorized-owner");
        require(escrowSource == address(0) && wrapperSource == address(0), "sources-already-set");
        require(escrow_ != address(0) && wrapper_ != address(0), "zero-source");
        escrowSource = escrow_;
        wrapperSource = wrapper_;
    }

    function setGovernance(address governance_) external {
        require(msg.sender == owner && governance == address(0) && !bindingActive, "governance-locked");
        _requireGovernanceController(governance_);
        governance = governance_;
    }

    /// @dev Explicit local-only one-time bootstrap; immutable once activated.
    function bootstrap(address governance_, bytes32 protocol_, uint256 version_, uint256 sourceChain_, uint256 destinationChain_) external {
        require(msg.sender == owner && !bindingActive && governance == address(0), "bootstrap-locked");
        _requireGovernanceController(governance_);
        require(protocol_ != bytes32(0) && version_ > 0 && sourceChain_ > 0 && destinationChain_ > 0, "invalid-binding");
        governance = governance_;
        protocolIdentifier = protocol_;
        messageVersion = version_;
        sourceChainId = sourceChain_;
        destinationChainId = destinationChain_;
        bindingActive = true;
    }

    function configureMessageBinding(bytes32 protocol_, uint256 version_, uint256 sourceChain_, uint256 destinationChain_) external {
        require(msg.sender == governance, "governance-required");
        require(protocol_ != bytes32(0) && version_ > 0 && sourceChain_ > 0 && destinationChain_ > 0, "invalid-binding");
        protocolIdentifier = protocol_;
        messageVersion = version_;
        sourceChainId = sourceChain_;
        destinationChainId = destinationChain_;
    }

    function setLimits(uint256 messageLimit_, uint256 dailyLimit_, uint256 window_) external {
        require(msg.sender == governance, "governance-required");
        require(messageLimit_ > 0 && dailyLimit_ > 0 && window_ > 0, "invalid-limits");
        maxMessageAmount = messageLimit_;
        maxDailyAmount = dailyLimit_;
        dailyWindow = window_;
        dailyWindowStart = block.timestamp;
        dailyAmountUsed = 0;
    }

    function consumeLimit(uint256 amount) external {
        require(msg.sender == escrowSource || msg.sender == wrapperSource, "unauthorized-limit-source");
        require(maxMessageAmount > 0 && maxDailyAmount > 0 && dailyWindow > 0, "limits-not-configured");
        require(amount > 0 && amount <= maxMessageAmount, "message-limit");
        require(amount <= maxDailyAmount, "daily-limit");
        if (block.timestamp >= dailyWindowStart + dailyWindow) {
            dailyWindowStart = block.timestamp;
            dailyAmountUsed = 0;
        }
        require(dailyAmountUsed <= maxDailyAmount - amount, "daily-limit");
        dailyAmountUsed += amount;
    }

    /// @dev Local-only simulated observer/finality policy. No RPC or chain access occurs.
    function configureFinality(uint256 observerQuorum_, uint256 staleHeadDepth_) external {
        require(msg.sender == governance, "governance-required");
        require(observerQuorum_ > 0 && staleHeadDepth_ > 0, "invalid-finality");
        observerQuorum = observerQuorum_;
        staleHeadDepth = staleHeadDepth_;
        finalityConfigured = true;
    }

    function configureObserver(address observer, bool allowed) external {
        require(msg.sender == governance, "governance-required");
        require(observer != address(0), "invalid-observer");
        isObserver[observer] = allowed;
    }

    function registerSourceHeader(address observer, uint256 number, bytes32 hash, bytes32 parentHash, bytes32 stateRoot) external {
        require(msg.sender == observer && isObserver[observer] && number > 0 && hash != bytes32(0) && stateRoot != bytes32(0), "invalid-source-header");
        require(!finalityConfigured || canonicalHeadNumber == 0 || number + staleHeadDepth >= canonicalHeadNumber, "stale-source-head");
        if (!observerHeaders[observer].registered) _observers.push(observer);
        observerHeaders[observer] = SourceHeader(number, hash, parentHash, stateRoot, true);
        emit SourceHeaderRegistered(observer, number, hash, stateRoot);
    }

    function registerSourceEvent(address observer, bytes32 operationId, uint256 number, bytes32 blockHash) external {
        require(msg.sender == observer && isObserver[observer] && observerHeaders[observer].registered, "invalid-source-event");
        SourceHeader memory header = observerHeaders[observer];
        require(operationId != bytes32(0) && header.number == number && header.hash == blockHash, "source-event-mismatch");
        sourceEventObservers[operationId][observer] = true;
        emit SourceEventRegistered(observer, operationId, number, blockHash);
    }

    function registerSourceEventBinding(
        address observer, bytes32 operationId, uint256 number, bytes32 blockHash,
        address emitter, bytes32 eventSignature, bytes32 txHash, uint256 logIndex,
        uint256 amount, address recipient
    ) external {
        require(msg.sender == observer && isObserver[observer] && observerHeaders[observer].registered, "invalid-source-event");
        SourceHeader memory header = observerHeaders[observer];
        require(operationId != bytes32(0) && header.number == number && header.hash == blockHash, "source-event-mismatch");
        require(emitter != address(0) && eventSignature != bytes32(0) && txHash != bytes32(0) && amount > 0 && recipient != address(0), "invalid-event-binding");
        sourceEventObservers[operationId][observer] = true;
        EventBinding storage binding = eventBindings[operationId];
        if (!binding.registered) {
            eventBindings[operationId] = EventBinding(
                operationId, emitter, eventSignature, txHash, logIndex, number, blockHash, amount, recipient, true
            );
            eventBindingCommitments[operationId] = keccak256(
                abi.encode(operationId, emitter, eventSignature, txHash, logIndex, number, blockHash, amount, recipient)
            );
        } else {
            require(
                binding.operationId == operationId && binding.emitter == emitter &&
                binding.eventSignature == eventSignature && binding.txHash == txHash &&
                binding.logIndex == logIndex && binding.sourceBlockNumber == number &&
                binding.sourceBlockHash == blockHash && binding.amount == amount &&
                binding.recipient == recipient,
                "event-binding-mismatch"
            );
        }
        require(eventBindingCommitments[operationId] == _eventBindingCommitment(binding), "event-binding-mismatch");
        emit SourceEventRegistered(observer, operationId, number, blockHash);
    }

    function _headerQuorum(uint256 number, bytes32 hash) private view returns (uint256 count, bytes32 root) {
        for (uint256 i; i < _observers.length; ++i) {
            SourceHeader memory h = observerHeaders[_observers[i]];
            if (isObserver[_observers[i]] && h.registered && h.number == number && h.hash == hash) {
                count++;
                if (root == bytes32(0)) root = h.stateRoot;
                else if (root != h.stateRoot) return (0, bytes32(0));
            }
        }
    }

    function _eventQuorum(bytes32 operationId, uint256 number, bytes32 hash) private view returns (uint256 count) {
        for (uint256 i; i < _observers.length; ++i) {
            address observer = _observers[i];
            SourceHeader memory h = observerHeaders[observer];
            if (isObserver[observer] && sourceEventObservers[operationId][observer] && h.number == number && h.hash == hash) count++;
        }
    }

    function _finalityFor(bytes32 operationId, bytes32 blockHash) private view returns (uint256 number, bytes32 root) {
        for (uint256 i; i < _observers.length; ++i) {
            SourceHeader memory h = observerHeaders[_observers[i]];
            if (h.registered && h.hash == blockHash) { number = h.number; break; }
        }
        require(number > 0, "source-header-not-found");
        (uint256 heads, bytes32 agreedRoot) = _headerQuorum(number, blockHash);
        require(heads >= observerQuorum && agreedRoot != bytes32(0), "observer-quorum-not-reached");
        require(_uniqueHead(number, blockHash), "observer-head-disagreement");
        root = agreedRoot;
    }

    function _uniqueHead(uint256 number, bytes32 selectedHash) private view returns (bool) {
        uint256 candidates;
        bytes32 seen;
        for (uint256 i; i < _observers.length; ++i) {
            SourceHeader memory h = observerHeaders[_observers[i]];
            if (!h.registered || h.number != number || h.hash == seen) continue;
            seen = h.hash;
            (uint256 count,) = _headerQuorum(number, h.hash);
            if (count >= observerQuorum) {
                candidates++;
                if (h.hash != selectedHash) return false;
            }
        }
        return candidates == 1;
    }

    function reconcileCanonicalHead(uint256 number, bytes32 hash, bytes32 root) external {
        require(msg.sender == owner, "unauthorized-owner");
        require(finalityConfigured, "finality-not-configured");
        require(canonicalHeadNumber == 0 || number >= canonicalHeadNumber, "stale-source-head");
        (uint256 heads, bytes32 agreedRoot) = _headerQuorum(number, hash);
        require(heads >= observerQuorum && agreedRoot == root, "observer-disagreement");
        require(_uniqueHead(number, hash), "observer-head-disagreement");
        canonicalHeadNumber = number; canonicalHeadHash = hash; canonicalHeadRoot = root;
        emit CanonicalHeadReconciled(number, hash, root);
        _invalidateReorgedProofs(hash);
    }

    function _invalidateReorgedProofs(bytes32 newHash) private {
        for (uint256 i; i < _proofIds.length; ++i) {
            bytes32 id = _proofIds[i];
            SourceProof storage lockProof = lockProofs[id];
            if (lockProof.registered && lockProof.finalized && !lockProof.consumed && lockProof.sourceBlockHash != newHash && _eventQuorum(id, finalizedBlockNumber[id], lockProof.sourceBlockHash) < observerQuorum) {
                invalidatedProofs[id] = true; emit SourceProofInvalidated(id, lockProof.sourceBlockHash);
            }
            SourceProof storage burnProof = burnProofs[id];
            if (burnProof.registered && burnProof.finalized && !burnProof.consumed && burnProof.sourceBlockHash != newHash && _eventQuorum(id, finalizedBlockNumber[id], burnProof.sourceBlockHash) < observerQuorum) {
                invalidatedProofs[id] = true; emit SourceProofInvalidated(id, burnProof.sourceBlockHash);
            }
        }
    }

    function _requireGovernanceController(address governance_) private view {
        require(governance_ != address(0) && governance_.code.length > 0, "invalid-governance-controller");
        (bool ok, bytes memory result) = governanceFactory.staticcall(
            abi.encodeWithSelector(IPhase4GovernanceFactory.isCanonicalGovernance.selector, governance_)
        );
        require(ok && result.length >= 32 && abi.decode(result, (bool)), "invalid-governance-controller");
    }

    function rotateSigner(address oldSigner, address newSigner) external {
        require(msg.sender == governance, "unauthorized-governance");
        require(isSigner[oldSigner] && newSigner != address(0) && !isSigner[newSigner], "invalid-rotation");
        isSigner[oldSigner] = false;
        isSigner[newSigner] = true;
        for (uint256 i; i < _signers.length; ++i) {
            if (_signers[i] == oldSigner) { _signers[i] = newSigner; break; }
        }
    }

    function revokeSigner(address signer) external {
        require(msg.sender == governance, "unauthorized-governance");
        require(isSigner[signer], "invalid-signer");
        uint256 active;
        for (uint256 i; i < _signers.length; ++i) if (isSigner[_signers[i]]) active++;
        require(active > quorum, "quorum-unsafe");
        isSigner[signer] = false;
    }

    function signers() external view returns (address[] memory) { return _signers; }

    function reserveOperation(bytes32 operationId) external {
        require(msg.sender == escrowSource || msg.sender == wrapperSource, "unauthorized-operation-source");
        require(operationId != bytes32(0), "invalid-operation-id");
        require(operationRegistry[operationId] == 0, "operation-id-already-used");
        operationRegistry[operationId] = msg.sender == escrowSource ? 1 : 2;
    }

    function attestationDigest(
        bytes32 sourceDomain, bytes32 destinationDomain, address canonicalToken, address wrapper,
        bytes32 operationId, uint256 nonce, uint256 amount, address sender, address recipient,
        bytes32 sourceBlockHash, uint256 expiry
    ) public view returns (bytes32) {
        bytes32 context = keccak256(abi.encode(
            protocolIdentifier, messageVersion, sourceChainId, destinationChainId,
            address(this), escrowSource, wrapperSource
        ));
        bytes32 message = keccak256(abi.encode(
            TYPE_HASH, sourceDomain, destinationDomain, canonicalToken, wrapper,
            operationId, nonce, amount, sender, recipient, sourceBlockHash, expiry
        ));
        return keccak256(abi.encode(context, message));
    }

    function registerLockProof(
        bytes32 operationId, uint256 nonce, bytes32 sourceBlockHash, uint256 expiry,
        uint256 amount, address sender, address recipient, address canonicalToken, address wrapper
    ) external {
        require(msg.sender == escrowSource, "unauthorized-proof-source");
        require(!lockProofs[operationId].registered, "proof-already-registered");
        SourceProof storage proof = lockProofs[operationId];
        proof.sourceDomain = bytes32(0); proof.destinationDomain = bytes32(0); proof.canonicalToken = canonicalToken; proof.wrapper = wrapper;
        proof.operationId = operationId; proof.nonce = nonce; proof.amount = amount; proof.sender = sender; proof.recipient = recipient;
        proof.sourceBlockHash = sourceBlockHash; proof.expiry = expiry; proof.eventTxHash = bytes32(0); proof.eventLogIndex = 0;
        proof.registered = true; proof.finalized = false; proof.consumed = false;
        _proofIds.push(operationId);
        lockProofs[operationId].sourceDomain = _sourceDomainForLock();
        lockProofs[operationId].destinationDomain = _destinationDomainForLock();
    }

    function registerBurnProof(
        bytes32 operationId, uint256 nonce, bytes32 sourceBlockHash, uint256 expiry,
        uint256 amount, address sender, address recipient, address canonicalToken, address wrapper,
        bytes32 sourceDomain, bytes32 destinationDomain
    ) external {
        require(msg.sender == wrapperSource, "unauthorized-proof-source");
        require(!burnProofs[operationId].registered, "proof-already-registered");
        SourceProof storage proof = burnProofs[operationId];
        proof.sourceDomain = sourceDomain; proof.destinationDomain = destinationDomain; proof.canonicalToken = canonicalToken; proof.wrapper = wrapper;
        proof.operationId = operationId; proof.nonce = nonce; proof.amount = amount; proof.sender = sender; proof.recipient = recipient;
        proof.sourceBlockHash = sourceBlockHash; proof.expiry = expiry; proof.eventTxHash = bytes32(0); proof.eventLogIndex = 0;
        proof.registered = true; proof.finalized = false; proof.consumed = false;
        _proofIds.push(operationId);
    }

    function bindLockProofEvent(bytes32 operationId, bytes32 eventTxHash, uint256 eventLogIndex) external {
        require(msg.sender == escrowSource, "unauthorized-proof-source");
        SourceProof storage proof = lockProofs[operationId];
        require(proof.registered && proof.eventTxHash == bytes32(0), "event-identity-already-bound");
        require(eventTxHash != bytes32(0), "invalid-event-identity");
        proof.eventTxHash = eventTxHash;
        proof.eventLogIndex = eventLogIndex;
    }

    function bindBurnProofEvent(bytes32 operationId, bytes32 eventTxHash, uint256 eventLogIndex) external {
        require(msg.sender == wrapperSource, "unauthorized-proof-source");
        SourceProof storage proof = burnProofs[operationId];
        require(proof.registered && proof.eventTxHash == bytes32(0), "event-identity-already-bound");
        require(eventTxHash != bytes32(0), "invalid-event-identity");
        proof.eventTxHash = eventTxHash;
        proof.eventLogIndex = eventLogIndex;
    }

    // The local fixture intentionally exposes manual finality assertions.
    function finalizeLockProof(bytes32 operationId) external {
        require(msg.sender == governance, "governance-required");
        SourceProof storage proof = lockProofs[operationId];
        require(proof.registered && !proof.finalized, "proof-already-finalized");
        if (finalityConfigured) {
            (uint256 number, bytes32 root) = _finalityFor(operationId, proof.sourceBlockHash);
            require(canonicalHeadNumber == 0 || number >= canonicalHeadNumber, "stale-source-finality");
            canonicalHeadNumber = number; canonicalHeadHash = proof.sourceBlockHash; canonicalHeadRoot = root;
            finalizedBlockNumber[operationId] = number; finalizedBlockHash[operationId] = proof.sourceBlockHash; finalizedBlockRoot[operationId] = root;
        }
        proof.finalized = true;
    }
    function finalizeBurnProof(bytes32 operationId) external {
        require(msg.sender == governance, "governance-required");
        SourceProof storage proof = burnProofs[operationId];
        require(proof.registered && !proof.finalized, "proof-already-finalized");
        if (finalityConfigured) {
            (uint256 number, bytes32 root) = _finalityFor(operationId, proof.sourceBlockHash);
            require(canonicalHeadNumber == 0 || number >= canonicalHeadNumber, "stale-source-finality");
            canonicalHeadNumber = number; canonicalHeadHash = proof.sourceBlockHash; canonicalHeadRoot = root;
            finalizedBlockNumber[operationId] = number; finalizedBlockHash[operationId] = proof.sourceBlockHash; finalizedBlockRoot[operationId] = root;
        }
        proof.finalized = true;
    }

    function consumeLockProof(
        bytes32 sourceDomain, bytes32 destinationDomain, address canonicalToken, address wrapper,
        bytes32 operationId, uint256 nonce, uint256 amount, address sender, address recipient,
        bytes32 sourceBlockHash, uint256 expiry
    ) external {
        require(msg.sender == wrapperSource, "unauthorized-proof-consumer");
        SourceProof storage proof = lockProofs[operationId];
        require(!failedLockProofs[operationId], "lock-proof-failed");
        _consume(proof, sourceDomain, destinationDomain, canonicalToken, wrapper, operationId, nonce, amount, sender, recipient, sourceBlockHash, expiry, "lock");
    }

    function consumeBurnProof(
        bytes32 sourceDomain, bytes32 destinationDomain, address canonicalToken, address wrapper,
        bytes32 operationId, uint256 nonce, uint256 amount, address sender, address recipient,
        bytes32 sourceBlockHash, uint256 expiry
    ) external {
        require(msg.sender == escrowSource, "unauthorized-proof-consumer");
        SourceProof storage proof = burnProofs[operationId];
        require(!failedBurnProofs[operationId], "burn-proof-failed");
        _consume(proof, sourceDomain, destinationDomain, canonicalToken, wrapper, operationId, nonce, amount, sender, recipient, sourceBlockHash, expiry, "burn");
    }

    function consumeLockProofEvent(bytes32 operationId, bytes32 eventTxHash, uint256 eventLogIndex) external {
        require(msg.sender == wrapperSource, "unauthorized-proof-consumer");
        SourceProof storage proof = lockProofs[operationId];
        require(!failedLockProofs[operationId], "lock-proof-failed");
        _consumeEventProof(proof, operationId, eventTxHash, eventLogIndex, "lock");
    }

    function consumeBurnProofEvent(bytes32 operationId, bytes32 eventTxHash, uint256 eventLogIndex) external {
        require(msg.sender == escrowSource, "unauthorized-proof-consumer");
        SourceProof storage proof = burnProofs[operationId];
        require(!failedBurnProofs[operationId], "burn-proof-failed");
        _consumeEventProof(proof, operationId, eventTxHash, eventLogIndex, "burn");
    }

    function _consumeEventProof(SourceProof storage proof, bytes32 operationId, bytes32 eventTxHash, uint256 eventLogIndex, string memory kind) private {
        require(proof.registered, string.concat(kind, "-proof-not-registered"));
        if (finalityConfigured) _assertFinalizedEvent(proof, operationId, eventTxHash, eventLogIndex, kind);
        require(!proof.consumed, string.concat(kind, "-proof-consumed"));
        proof.consumed = true;
    }

    function _assertFinalizedEvent(SourceProof storage proof, bytes32 operationId, bytes32 eventTxHash, uint256 eventLogIndex, string memory kind) private view {
        _verifyEventBinding(operationId, EventIdentity(eventTxHash, eventLogIndex), kind);
        require(proof.finalized, string.concat(kind, "-proof-not-finalized"));
        require(!invalidatedProofs[operationId], string.concat(kind, "-proof-invalidated"));
        require(canonicalHeadHash == proof.sourceBlockHash && canonicalHeadNumber == finalizedBlockNumber[operationId] && canonicalHeadRoot == finalizedBlockRoot[operationId], string.concat(kind, "-canonical-finality-mismatch"));
    }

    function _consume(SourceProof storage proof, bytes32 sourceDomain, bytes32 destinationDomain, address canonicalToken, address wrapper, bytes32 operationId, uint256 nonce, uint256 amount, address sender, address recipient, bytes32 sourceBlockHash, uint256 expiry, string memory kind) private {
        require(bindingActive && sourceChainId > 0 && destinationChainId > 0 && sourceDomain != bytes32(0) && destinationDomain != bytes32(0), "binding-inactive");
        require(proof.registered, string.concat(kind, "-proof-not-registered"));
        require(proof.finalized, string.concat(kind, "-proof-not-finalized"));
        require(!invalidatedProofs[operationId], string.concat(kind, "-proof-invalidated"));
        if (finalityConfigured) require(canonicalHeadHash == sourceBlockHash && canonicalHeadNumber == finalizedBlockNumber[operationId] && canonicalHeadRoot == finalizedBlockRoot[operationId], string.concat(kind, "-canonical-finality-mismatch"));
        require(!proof.consumed, string.concat(kind, "-proof-consumed"));
        require(
            proof.sourceDomain == sourceDomain && proof.destinationDomain == destinationDomain &&
            proof.canonicalToken == canonicalToken && proof.wrapper == wrapper && proof.operationId == operationId &&
            proof.nonce == nonce && proof.amount == amount && proof.sender == sender && proof.recipient == recipient &&
            proof.sourceBlockHash == sourceBlockHash && proof.expiry == expiry,
            string.concat(kind, "-proof-mismatch")
        );
    }

    function _eventBindingCommitment(EventBinding memory binding) private pure returns (bytes32) {
        return keccak256(abi.encode(
            binding.operationId, binding.emitter, binding.eventSignature, binding.txHash,
            binding.logIndex, binding.sourceBlockNumber, binding.sourceBlockHash,
            binding.amount, binding.recipient
        ));
    }

    function _verifyEventBinding(
        bytes32 operationId, EventIdentity memory eventIdentity, string memory kind
    ) private view {
        bool isLock = keccak256(bytes(kind)) == keccak256(bytes("lock"));
        SourceProof memory proof = isLock ? lockProofs[operationId] : burnProofs[operationId];
        EventBinding memory binding = eventBindings[operationId];
        require(
            proof.eventTxHash == eventIdentity.txHash && proof.eventLogIndex == eventIdentity.logIndex,
            "event-binding-mismatch"
        );
        require(
            binding.registered && binding.operationId == operationId && binding.txHash != bytes32(0) &&
            eventIdentity.txHash != bytes32(0) && eventBindingCommitments[operationId] == _eventBindingCommitment(binding),
            "event-binding-missing"
        );
        address expectedEmitter = isLock ? escrowSource : wrapperSource;
        bytes32 expectedSignature = isLock
            ? keccak256("Locked(bytes32,address,address,uint256)")
            : keccak256("Burned(bytes32,address,address,uint256)");
        require(
            binding.emitter == expectedEmitter && binding.eventSignature == expectedSignature &&
            binding.txHash == eventIdentity.txHash && binding.logIndex == eventIdentity.logIndex &&
            binding.sourceBlockHash == proof.sourceBlockHash && binding.amount == proof.amount &&
            binding.recipient == proof.recipient,
            "event-binding-mismatch"
        );
        if (finalityConfigured) require(
            binding.sourceBlockNumber == finalizedBlockNumber[operationId] &&
            binding.sourceBlockHash == finalizedBlockHash[operationId],
            "event-source-mismatch"
        );
    }

    // Domain values are supplied by the source contracts through these local-only setters in practice.
    bytes32 private _lockSourceDomain;
    bytes32 private _lockDestinationDomain;
    function setLockDomains(bytes32 sourceDomain, bytes32 destinationDomain) external {
        require(escrowSource == address(0) || msg.sender == escrowSource, "unauthorized-domain-source");
        require(sourceDomain != bytes32(0) && destinationDomain != bytes32(0), "invalid-domains");
        _lockSourceDomain = sourceDomain;
        _lockDestinationDomain = destinationDomain;
    }
    function lockProofRecoverable(bytes32 operationId) external view returns (bool) {
        SourceProof memory proof = lockProofs[operationId];
        return proof.registered && !proof.consumed && (invalidatedProofs[operationId] || failedLockProofs[operationId] || block.timestamp > proof.expiry);
    }
    function burnProofRecoverable(bytes32 operationId) external view returns (bool) {
        SourceProof memory proof = burnProofs[operationId];
        return proof.registered && !proof.consumed && (invalidatedProofs[operationId] || failedBurnProofs[operationId] || block.timestamp > proof.expiry);
    }
    function markLockProofFailed(bytes32 operationId) external {
        require(msg.sender == governance, "governance-required");
        require(lockProofs[operationId].registered && !lockProofs[operationId].consumed, "proof-not-recoverable");
        failedLockProofs[operationId] = true;
    }
    function markBurnProofFailed(bytes32 operationId) external {
        require(msg.sender == governance, "governance-required");
        require(burnProofs[operationId].registered && !burnProofs[operationId].consumed, "proof-not-recoverable");
        failedBurnProofs[operationId] = true;
    }
    function cancelLockProof(bytes32 operationId) external {
        require(msg.sender == escrowSource, "unauthorized-proof-consumer");
        SourceProof storage proof = lockProofs[operationId];
        require(proof.registered && !proof.consumed, "lock-proof-consumed");
        proof.consumed = true;
    }
    function cancelBurnProof(bytes32 operationId) external {
        require(msg.sender == wrapperSource, "unauthorized-proof-consumer");
        SourceProof storage proof = burnProofs[operationId];
        require(proof.registered && !proof.consumed, "burn-proof-consumed");
        proof.consumed = true;
    }
    function _sourceDomainForLock() private view returns (bytes32) { return _lockSourceDomain; }
    function _destinationDomainForLock() private view returns (bytes32) { return _lockDestinationDomain; }

    function verify(bytes32 digest, bytes[] calldata signatures) external view returns (bool) {
        require(signatures.length >= quorum, "insufficient-signatures");
        address lastSigner;
        for (uint256 i; i < signatures.length; ++i) {
            address recovered = (keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest))).recover(signatures[i]);
            require(isSigner[recovered], "unauthorized-signer");
            require(recovered > lastSigner, "duplicate-or-unsorted-signers");
            lastSigner = recovered;
        }
        return true;
    }
}
