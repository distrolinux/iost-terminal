// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {Phase4Governance} from "./Phase4Governance.sol";

/// @dev Local-only canonical deployment registry for the Phase 4 governance harness.
/// Only governance instances created by this factory are recognized by the verifier.
contract Phase4GovernanceFactory {
    mapping(address => bool) public isCanonicalGovernance;

    event GovernanceCreated(address indexed governance, bytes32 indexed deploymentId);

    function createGovernance(
        address[] calldata owners_,
        uint256 quorum_,
        uint256 timelockDelay_
    ) external returns (address governance) {
        Phase4Governance instance = new Phase4Governance(owners_, quorum_, timelockDelay_);
        governance = address(instance);
        isCanonicalGovernance[governance] = true;
        emit GovernanceCreated(governance, keccak256(abi.encode(governance, owners_, quorum_, timelockDelay_)));
    }
}
