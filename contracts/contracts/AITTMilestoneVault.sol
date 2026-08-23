// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AITTMilestoneVault — fixed allocation with mandatory 48-hour queue.
/// @notice Used for treasury, partners, community, and reserve allocations.
///         Governance queues a recipient/amount plus evidence hash; anyone may
///         execute after the immutable delay. A queued release can be cancelled
///         before execution, and total released can never exceed the allocation.
contract AITTMilestoneVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant RELEASE_DELAY = 48 hours;

    IERC20 public immutable token;
    uint256 public immutable totalAllocated;
    uint256 public released;
    uint256 public queued;
    uint256 private nonce;

    struct Release {
        address recipient;
        uint256 amount;
        bytes32 evidenceHash;
        uint256 executeAfter;
        bool exists;
        bool cancelled;
        bool executed;
    }

    mapping(bytes32 => Release) public releases;

    event ReleaseQueued(bytes32 indexed operationId, address indexed recipient, uint256 amount, bytes32 indexed evidenceHash, uint256 executeAfter);
    event ReleaseCancelled(bytes32 indexed operationId);
    event ReleaseExecuted(bytes32 indexed operationId, address indexed recipient, uint256 amount);
    event ExcessRecovered(address indexed recipient, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error AllocationExceeded();
    error VaultUnderfunded();
    error ReleaseUnavailable();
    error ReleaseNotReady();
    error ZeroEvidenceHash();

    constructor(IERC20 token_, uint256 totalAllocated_, address initialOwner)
        Ownable(initialOwner)
    {
        if (address(token_) == address(0) || initialOwner == address(0)) revert ZeroAddress();
        if (totalAllocated_ == 0) revert ZeroAmount();
        token = token_;
        totalAllocated = totalAllocated_;
    }

    function queueRelease(address recipient, uint256 amount, bytes32 evidenceHash)
        external
        onlyOwner
        returns (bytes32 operationId)
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (evidenceHash == bytes32(0)) revert ZeroEvidenceHash();
        if (token.balanceOf(address(this)) + released < totalAllocated) revert VaultUnderfunded();
        if (released + queued + amount > totalAllocated) revert AllocationExceeded();

        operationId = keccak256(abi.encode(block.chainid, address(this), nonce++, recipient, amount, evidenceHash));
        uint256 executeAfter = block.timestamp + RELEASE_DELAY;
        releases[operationId] = Release({
            recipient: recipient,
            amount: amount,
            evidenceHash: evidenceHash,
            executeAfter: executeAfter,
            exists: true,
            cancelled: false,
            executed: false
        });
        queued += amount;
        emit ReleaseQueued(operationId, recipient, amount, evidenceHash, executeAfter);
    }

    function cancelRelease(bytes32 operationId) external onlyOwner {
        Release storage op = releases[operationId];
        if (!op.exists || op.cancelled || op.executed) revert ReleaseUnavailable();
        op.cancelled = true;
        queued -= op.amount;
        emit ReleaseCancelled(operationId);
    }

    function executeRelease(bytes32 operationId) external nonReentrant {
        Release storage op = releases[operationId];
        if (!op.exists || op.cancelled || op.executed) revert ReleaseUnavailable();
        if (block.timestamp < op.executeAfter) revert ReleaseNotReady();

        op.executed = true;
        queued -= op.amount;
        released += op.amount;
        token.safeTransfer(op.recipient, op.amount);
        emit ReleaseExecuted(operationId, op.recipient, op.amount);
    }

    /// @notice Recover only AITT accidentally sent above remaining allocation liabilities.
    function recoverExcessAITT(address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 balance = token.balanceOf(address(this));
        uint256 liability = totalAllocated - released;
        uint256 excess = balance > liability ? balance - liability : 0;
        if (amount > excess) revert AllocationExceeded();
        token.safeTransfer(recipient, amount);
        emit ExcessRecovered(recipient, amount);
    }
}
