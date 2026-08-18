// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Agent Intelligence Trading Token (AITT)
/// @notice ERC-20 utility token of IOST Terminal (iostcallister.com).
/// @dev Fixed supply, minted exactly once at deployment. No mint/burn functions —
///      supply cannot change. Standard OpenZeppelin implementation only.
contract AITT is ERC20, Ownable {
    /// 1,000,000,000 tokens with 8 decimals.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 10 ** 8;

    /// @dev Design locked: 8 decimals (TOKENOMICS.md §2). OZ ERC-20 defaults to
    ///      18 — override it.
    function decimals() public pure override returns (uint8) {
        return 8;
    }

    /// @param initialOwner Address that receives the full supply at deployment
    ///        (the allocation distributor). Ownership of the token contract itself
    ///        is administrative only (e.g. renounceable) and grants no mint rights.
    constructor(address initialOwner)
        ERC20("Agent Intelligence Trading Token", "AITT")
        Ownable(initialOwner)
    {
        require(initialOwner != address(0), "AITT: zero initial owner");
        _mint(initialOwner, TOTAL_SUPPLY);
    }
}
