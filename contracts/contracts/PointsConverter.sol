// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PointsConverter — earned platform points → AITT (1:1, at TGE).
/// @notice The off-chain points ledger (live on iostcallister.com) remains the
///         source of truth. The platform operator approves claim amounts from a
///         signed/verified ledger snapshot; users then claim AITT 1:1 up to the
///         contract's funded reserve. Conversion is an earn-event, never a purchase.
///
///         Flow:
///         1. Owner funds the reserve with AITT (from the ecosystem pool).
///         2. Operator sets claimable[user] per ledger snapshot (points burned
///            off-chain in the same operation).
///         3. User calls `convert()` → receives AITT 1:1, capped at claimable
///            and at the remaining reserve.
/// @dev The 1:1 rate is a design constant of TOKENOMICS.md §4.6. Operator key is
///      the platform backend (short-lived, rotating). Owner is the project DAO
///      wallet until governance exists.
contract PointsConverter is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Locked 1:1 rule: 1 whole point = 1 whole AITT. Amounts passed to
    ///         this contract are ERC-20 base units, so the operator must submit
    ///         `points * 10**8` for this 8-decimal token.
    IERC20 public immutable token;
    address public operator;

    /// @notice AITT available for conversions (decreases as users claim).
    uint256 public reserve;
    /// @notice Sum of unclaimed approvals across all users (approved − claimed).
    uint256 public totalOutstanding;
    /// @notice Per-user amount approved (last ledger snapshot).
    mapping(address => uint256) public approved;
    /// @notice Per-user amount already claimed.
    mapping(address => uint256) public claimed;

    event OperatorChanged(address indexed operator);
    event Approved(address indexed user, uint256 amount);
    event Converted(address indexed user, uint256 amount);
    event ReserveFunded(uint256 amount);
    event ReserveWithdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NotOperator();
    error NothingToClaim();
    error InsufficientReserve();
    error AlreadyClaimed();
    error CannotReduceApproval();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(IERC20 token_, address operator_) Ownable(msg.sender) {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (operator_ == address(0)) revert ZeroAddress();
        token = token_;
        operator = operator_;
    }

    /// @notice Set/rotate the platform operator.
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        operator = newOperator;
        emit OperatorChanged(newOperator);
    }

    /// @notice Fund the conversion reserve. Pulls AITT from the owner.
    function fundReserve(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        token.safeTransferFrom(msg.sender, address(this), amount);
        reserve += amount;
        emit ReserveFunded(amount);
    }

    /// @notice Approve claim amounts for a ledger snapshot (operator only).
    ///         Re-approving a user overwrites their previous approval; total
    ///         approved must stay within the funded reserve.
    /// @dev Callers should pass the full snapshot (all users), not deltas.
    function approveClaims(address[] calldata users, uint256[] calldata amounts)
        external
        onlyOperator
        whenNotPaused
    {
        uint256 n = users.length;
        if (n == 0) revert ZeroAmount();
        if (n != amounts.length) revert ZeroAmount();

        for (uint256 i = 0; i < n; ++i) {
            address user = users[i];
            if (user == address(0)) revert ZeroAddress();
            uint256 amount = amounts[i];
            uint256 claimedUser = claimed[user];
            // Never allow an approval below what the user already claimed: it would
            // brick convert()/claimable() via underflow (approved - claimed reverts).
            if (amount < claimedUser) revert CannotReduceApproval();
            uint256 oldOutstanding = approved[user] > claimedUser ? approved[user] - claimedUser : 0;
            uint256 newOutstanding = amount > claimedUser ? amount - claimedUser : 0;
            totalOutstanding = totalOutstanding - oldOutstanding + newOutstanding;
            approved[user] = amount;
            emit Approved(user, amount);
        }
        // Outstanding claims must always fit inside the funded reserve.
        if (totalOutstanding > reserve) revert InsufficientReserve();
    }

    /// @notice Claim your approved AITT 1:1.
    function convert() external whenNotPaused nonReentrant {
        uint256 amount = approved[msg.sender] - claimed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        if (amount > reserve) revert InsufficientReserve();

        claimed[msg.sender] += amount;
        reserve -= amount;
        totalOutstanding -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Converted(msg.sender, amount);
    }

    /// @notice Remaining claimable amount for a user.
    function claimable(address user) external view returns (uint256) {
        return approved[user] > claimed[user] ? approved[user] - claimed[user] : 0;
    }

    /// @notice Owner withdraws unused reserve once the conversion window closes
    ///         (DAO decision; any AITT not claimed returns to the ecosystem pool).
    /// @dev Never withdraw below what is still owed to users (totalOutstanding).
    function withdrawReserve(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > reserve - totalOutstanding) revert ZeroAmount();
        reserve -= amount;
        token.safeTransfer(to, amount);
        emit ReserveWithdrawn(to, amount);
    }

    /// @dev OZ v5 Pausable exposes only internal hooks; public pause/unpause are
    ///      owner-gated here (emergency stop for the conversion window).
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
