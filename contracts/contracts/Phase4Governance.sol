// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// @dev Local-only multisig/timelock harness for Phase 4 prototype tests.
/// It is not a production Safe, governance system, or chain-finality mechanism.
contract Phase4Governance {
    bytes4 private constant GOVERNANCE_CONTROLLER_MARKER = bytes4(keccak256("AITT_PHASE4_GOVERNANCE_CONTROLLER_V1"));

    struct Proposal {
        address target;
        uint256 value;
        bytes data;
        uint256 eta;
        uint256 approvals;
        bool executed;
    }

    address[] private _owners;
    mapping(address => bool) public isOwner;
    mapping(bytes32 => Proposal) public proposals;
    mapping(bytes32 => mapping(address => bool)) public approved;
    uint256 public immutable quorum;
    uint256 public immutable timelockDelay;

    event ProposalCreated(bytes32 indexed id, address indexed target, uint256 eta);
    event ProposalApproved(bytes32 indexed id, address indexed owner);
    event ProposalExecuted(bytes32 indexed id);

    constructor(address[] memory owners_, uint256 quorum_, uint256 timelockDelay_) {
        require(owners_.length > 0 && quorum_ > 0 && quorum_ <= owners_.length, "invalid-quorum");
        for (uint256 i; i < owners_.length; ++i) {
            require(owners_[i] != address(0) && !isOwner[owners_[i]], "invalid-owner");
            isOwner[owners_[i]] = true;
            _owners.push(owners_[i]);
        }
        quorum = quorum_;
        timelockDelay = timelockDelay_;
    }

    function phase4GovernanceController() external pure returns (bytes4) {
        return GOVERNANCE_CONTROLLER_MARKER;
    }

    function owners() external view returns (address[] memory) { return _owners; }

    function propose(address target, uint256 value, bytes calldata data) external returns (bytes32 id) {
        require(isOwner[msg.sender], "not-owner");
        require(target != address(0), "zero-target");
        id = keccak256(abi.encode(target, value, data, block.timestamp, _owners.length));
        require(proposals[id].target == address(0), "proposal-exists");
        proposals[id] = Proposal(target, value, data, block.timestamp + timelockDelay, 0, false);
        emit ProposalCreated(id, target, proposals[id].eta);
    }

    function approve(bytes32 id) external {
        require(isOwner[msg.sender], "not-owner");
        Proposal storage proposal = proposals[id];
        require(proposal.target != address(0), "proposal-not-found");
        require(!proposal.executed, "proposal-executed");
        require(!approved[id][msg.sender], "already-approved");
        (bool checked, bytes memory result) = proposal.target.staticcall(
            abi.encodeWithSignature("isSigner(address)", msg.sender)
        );
        if (checked && result.length >= 32) {
            require(abi.decode(result, (bool)), "inactive-governance-signer");
        }
        approved[id][msg.sender] = true;
        proposal.approvals += 1;
        emit ProposalApproved(id, msg.sender);
    }

    function execute(bytes32 id) external returns (bytes memory result) {
        Proposal storage proposal = proposals[id];
        require(proposal.target != address(0), "proposal-not-found");
        require(!proposal.executed, "proposal-executed");
        require(proposal.approvals >= quorum, "quorum-not-reached");
        require(block.timestamp >= proposal.eta, "timelock-active");
        proposal.executed = true;
        (bool success, bytes memory returndata) = proposal.target.call{value: proposal.value}(proposal.data);
        require(success, "proposal-call-failed");
        emit ProposalExecuted(id);
        return returndata;
    }
}
