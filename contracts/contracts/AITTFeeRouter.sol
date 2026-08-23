// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IAITTProtocolBurn is IERC20 {
    function treasury() external view returns (address);
    function stakersPool() external view returns (address);
    function protocolBurn(uint256 amount)
        external
        returns (uint256 burned, uint256 redirectedToStakers, uint256 redirectedToTreasury);
}

/// @title AITTFeeRouter — authoritative external fee and DAO burn path.
/// @notice Platform fees use 50% stakers / 20% protocol burn / 30% treasury.
///         The AITT token owns the global floor and redirects unburnable burn
///         share 70/30, yielding 64%/36% overall once the floor is reached.
contract AITTFeeRouter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant STAKERS_BPS = 5_000;
    uint256 private constant BURN_BPS = 2_000;
    uint256 private constant SPLIT_UNIT = 10;

    IAITTProtocolBurn public immutable token;
    address public immutable treasury;
    address public immutable stakersPool;
    uint256 public platformFeesProcessed;
    uint256 public platformFeePending;

    event PlatformFeeProcessed(address indexed payer, uint256 amount, uint256 stakersBase, uint256 treasuryBase, uint256 burnRequested, uint256 burned, uint256 redirectedToStakers, uint256 redirectedToTreasury);
    event DaoBurnProcessed(address indexed owner, uint256 requested, uint256 burned, uint256 redirectedToStakers, uint256 redirectedToTreasury);

    error ZeroAddress();
    error ZeroAmount();
    error TransferAmountMismatch();

    constructor(IERC20 token_, address initialOwner)
        Ownable(initialOwner)
    {
        if (address(token_) == address(0) || initialOwner == address(0)) revert ZeroAddress();
        token = IAITTProtocolBurn(address(token_));
        treasury = token.treasury();
        stakersPool = token.stakersPool();
        if (treasury == address(0) || stakersPool == address(0)) revert ZeroAddress();
    }

    function _pullExact(address from, uint256 amount) internal {
        uint256 beforeBalance = token.balanceOf(address(this));
        IERC20(address(token)).safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert TransferAmountMismatch();
    }

    /// @notice Pull and process one AITT-denominated platform fee.
    function payPlatformFee(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _pullExact(msg.sender, amount);
        _processPlatformFee(msg.sender, amount);
    }

    /// @notice Process AITT already held by the router, preventing accidental lockup.
    function processHeldPlatformFee(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 held = token.balanceOf(address(this));
        if (held < platformFeePending || held - platformFeePending < amount) revert TransferAmountMismatch();
        _processPlatformFee(msg.sender, amount);
    }

    function _processPlatformFee(address payer, uint256 amount) internal {
        platformFeePending += amount;
        uint256 processAmount = platformFeePending - (platformFeePending % SPLIT_UNIT);
        platformFeePending -= processAmount;
        platformFeesProcessed += processAmount;

        uint256 stakersBase = (processAmount * STAKERS_BPS) / BPS;
        uint256 burnRequested = (processAmount * BURN_BPS) / BPS;
        uint256 treasuryBase = processAmount - stakersBase - burnRequested;

        if (stakersBase > 0) IERC20(address(token)).safeTransfer(stakersPool, stakersBase);
        if (treasuryBase > 0) IERC20(address(token)).safeTransfer(treasury, treasuryBase);
        uint256 burned = 0;
        uint256 redirectStakers = 0;
        uint256 redirectTreasury = 0;
        if (burnRequested > 0) {
            (burned, redirectStakers, redirectTreasury) = token.protocolBurn(burnRequested);
        }

        emit PlatformFeeProcessed(payer, amount, stakersBase, treasuryBase, burnRequested, burned, redirectStakers, redirectTreasury);
    }

    /// @notice DAO/owner buy-back burn through the same token-owned floor.
    function executeDaoBurn(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _pullExact(msg.sender, amount);
        (uint256 burned, uint256 redirectStakers, uint256 redirectTreasury) = token.protocolBurn(amount);
        emit DaoBurnProcessed(msg.sender, amount, burned, redirectStakers, redirectTreasury);
    }
}