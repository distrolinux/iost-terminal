// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AITTVesting — cliff + linear vesting for AITT allocations.
/// @notice Holds a locked allocation and releases it to a single beneficiary on a
///         cliff-then-linear schedule. Tokens are sent to the contract by the
///         distributor at deployment; the contract never holds anything else.
/// @dev Schedule (e.g. Team): 12-month cliff, then linear release over 36 months.
///      Advisors: 12-month cliff, then linear over 24 months. Both are fully
///      vested 48/36 months after `start`.
contract AITTVesting is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable beneficiary;
    /// @notice Vesting epoch start (unix ts). Cliff and duration are measured from here.
    uint256 public immutable start;
    /// @notice Seconds after `start` before any tokens vest.
    uint256 public immutable cliffDuration;
    /// @notice Linear release period in seconds after the cliff.
    uint256 public immutable duration;
    /// @notice Total AITT locked in this schedule.
    uint256 public immutable totalAllocated;

    /// @notice Total AITT already released to the beneficiary.
    uint256 public released;

    event Released(address indexed beneficiary, uint256 amount);

    /// @param token_ AITT token contract.
    /// @param beneficiary_ Address that may claim vested tokens.
    /// @param start_ Epoch start timestamp (0 = deployment time).
    /// @param cliffDuration_ Cliff length in seconds (e.g. 365 days).
    /// @param duration_ Linear period in seconds after cliff (e.g. 1095 days).
    /// @param totalAllocated_ Amount locked. The distributor must transfer this
    ///        amount to the contract (before or right after deployment).
    constructor(
        IERC20 token_,
        address beneficiary_,
        uint256 start_,
        uint256 cliffDuration_,
        uint256 duration_,
        uint256 totalAllocated_
    ) Ownable(msg.sender) {
        require(address(token_) != address(0), "AITTVesting: zero token");
        require(beneficiary_ != address(0), "AITTVesting: zero beneficiary");
        require(duration_ > 0, "AITTVesting: zero duration");
        require(totalAllocated_ > 0, "AITTVesting: zero allocation");
        token = token_;
        beneficiary = beneficiary_;
        start = start_ == 0 ? block.timestamp : start_;
        cliffDuration = cliffDuration_;
        duration = duration_;
        totalAllocated = totalAllocated_;
    }

    /// @notice Timestamp when the cliff ends and linear vesting begins.
    function cliffEnd() public view returns (uint256) {
        return start + cliffDuration;
    }

    /// @notice Total vested amount as of now.
    function vestedAmount() public view returns (uint256) {
        uint256 _now = block.timestamp;
        if (_now < cliffEnd()) {
            return 0;
        }
        if (_now >= cliffEnd() + duration) {
            return totalAllocated;
        }
        return (totalAllocated * (_now - cliffEnd())) / duration;
    }

    /// @notice Amount currently releasable (vested minus already released).
    function releasable() public view returns (uint256) {
        return vestedAmount() - released;
    }

    /// @notice Beneficiary claims their vested AITT.
    function release() external nonReentrant {
        uint256 amount = releasable();
        require(amount > 0, "AITTVesting: nothing to release");
        released += amount;
        token.safeTransfer(beneficiary, amount);
        emit Released(beneficiary, amount);
    }

    /// @notice Owner may recover accidentally sent tokens that are NOT the vested
    ///         token (e.g. someone airdrops another ERC-20 here).
    function sweep(IERC20 foreignToken, address to, uint256 amount) external onlyOwner {
        require(address(foreignToken) != address(token), "AITTVesting: vested token");
        foreignToken.safeTransfer(to, amount);
    }
}
