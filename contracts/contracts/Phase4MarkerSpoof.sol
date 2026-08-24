// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @dev Deliberately not Phase4Governance; used to prove marker-only checks are insufficient.
contract Phase4MarkerSpoof {
    bytes4 private constant MARKER = bytes4(keccak256("AITT_PHASE4_GOVERNANCE_CONTROLLER_V1"));

    function phase4GovernanceController() external pure returns (bytes4) {
        return MARKER;
    }
}
