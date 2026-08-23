// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title Agent Intelligence Trading Token (AITT)
/// @notice ERC-20 utility token of IOST Terminal (iostcallister.com).
/// @dev Fixed supply, minted exactly once at deployment. Swap tax per
///      TOKENOMICS.md v1.4 (locked 2026-08-19): 3% on AMM-pair buy/sell only —
///      1.8% burn / 0.8% stakers / 0.4% treasury; 0% on wallet-to-wallet,
///      staking, airdrops, and platform transfers. The burn share is capped at
///      200M cumulative (800M supply floor); post-cap it redirects to stakers
///      70/30. The AMM pair is set once (one-time setter) because the pair is
///      created only after this token is deployed; afterwards no privileged
///      functions remain.
contract AITT is ERC20, Ownable {
    /// 1,000,000,000 tokens with 8 decimals.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 10 ** 8;

    /// 800,000,000 supply floor — cumulative contract burn can never exceed 200M.
    uint256 public constant SUPPLY_FLOOR = 800_000_000 * 10 ** 8;

    /// Basis-point denominator (3% = 300 bps; split below sums to 300).
    uint256 private constant BPS = 10_000;

    /// Burn share: 180 bps (1.8%) — clamped by the cumulative 200M cap.
    uint256 private constant BURN_BPS = 180;
    /// Stakers share: 80 bps (0.8%).
    uint256 private constant STAKERS_BPS = 80;
    /// Treasury share: 40 bps (0.4%).
    uint256 private constant TREASURY_BPS = 40;

    /// Post-cap redirect: 70% of the (capped) burn share goes to stakers,
    /// the remaining 30% to treasury.
    uint256 private constant REDIRECT_STAKERS_NUM = 70;
    uint256 private constant REDIRECT_DENOM = 100;

    /// Recipients of the non-burn fee shares (set once at deployment).
    address public immutable treasury;
    address public immutable stakersPool;

    /// The taxed AMM pair. Set once via {setAmmPair}; thereafter immutable.
    address public ammPair;

    /// @dev Emitted when the swap-tax pair is locked in.
    event AmmPairSet(address indexed pair);

    /// @dev Design locked: 8 decimals (TOKENOMICS.md §2). OZ ERC-20 defaults to
    ///      18 — override it.
    function decimals() public pure override returns (uint8) {
        return 8;
    }

    /// @param initialOwner Address that receives the full supply at deployment
    ///        (the allocation distributor).
    /// @param treasury_ DAO treasury — receives 0.4% of taxed swap volume.
    /// @param stakersPool_ Staker-rewards recipient — receives 0.8% of taxed
    ///        swap volume. Phase 1: DAO-controlled wallet; Phase 2: the staking
    ///        contract (deployment-time decision — see PHASE1_SPEC.md; token
    ///        is re-deployable before TGE, which is gated on 10k users).
    constructor(
        address initialOwner,
        address treasury_,
        address stakersPool_
    )
        ERC20("Agent Intelligence Trading Token", "AITT")
        Ownable(initialOwner)
    {
        require(initialOwner != address(0), "AITT: zero initial owner");
        require(treasury_ != address(0), "AITT: zero treasury");
        require(stakersPool_ != address(0), "AITT: zero stakers pool");
        treasury = treasury_;
        stakersPool = stakersPool_;
        _mint(initialOwner, TOTAL_SUPPLY);
    }

    /// @notice Locks the taxed AMM pair. Owner-only, one-time, permanent.
    /// @dev The DEX pair is created after this token is deployed
    ///      (factory.createPair), so its address cannot be known at
    ///      construction. Once set, the tax applies to sell (user→pair) and
    ///      buy (pair→user) transfers; LP add/remove also touch the pair and
    ///      are taxed (standard fee-token behavior, documented in PHASE1_SPEC).
    function setAmmPair(address pair) external onlyOwner {
        require(ammPair == address(0), "AITT: pair already set");
        require(pair != address(0), "AITT: zero pair");
        ammPair = pair;
        emit AmmPairSet(pair);
    }

    /// @notice Applies the 3% swap tax on AMM-pair transfers only.
    /// @dev Every balance movement flows through this hook (mints, burns, and
    ///      transfers). The tax applies only when one side is the AMM pair —
    ///      wallet-to-wallet, staking, airdrops, and platform flows are
    ///      untaxed. The burn share is clamped to the 200M cumulative cap
    ///      (800M floor); post-cap the excess redirects to stakers 70/30.
    ///      Rounding dust stays with the recipient — no value is ever lost.
    function _update(address from, address to, uint256 value) internal override {
        address pair = ammPair;
        if (pair == address(0) || (from != pair && to != pair)) {
            super._update(from, to, value);
            return;
        }

        uint256 burnShare = (value * BURN_BPS) / BPS;
        uint256 stakersShare = (value * STAKERS_BPS) / BPS;
        uint256 treasuryShare = (value * TREASURY_BPS) / BPS;
        uint256 toRecipient = value - burnShare - stakersShare - treasuryShare;

        // Cumulative burn cap: total supply never falls below the 800M floor.
        uint256 headroom = totalSupply() - SUPPLY_FLOOR;
        if (burnShare > headroom) {
            uint256 excess = burnShare - headroom;
            burnShare = headroom;
            uint256 toStakers = (excess * REDIRECT_STAKERS_NUM) / REDIRECT_DENOM;
            stakersShare += toStakers;
            treasuryShare += excess - toStakers;
        }

        if (stakersShare > 0) super._update(from, stakersPool, stakersShare);
        if (treasuryShare > 0) super._update(from, treasury, treasuryShare);
        if (burnShare > 0) super._update(from, address(0), burnShare);
        super._update(from, to, toRecipient);
    }
}
