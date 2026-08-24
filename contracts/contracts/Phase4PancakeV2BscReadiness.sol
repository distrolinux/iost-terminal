// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @dev Hardhat-local identity fixture for Phase 4 readiness tests only.
/// It does not verify live BSC state, authorize deployment, or activate a gate.
contract Phase4PancakeV2BscReadiness {
    uint256 public constant BSC_CHAIN_ID = 56;
    address public constant PANCAKE_V2_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address public constant PANCAKE_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
}
