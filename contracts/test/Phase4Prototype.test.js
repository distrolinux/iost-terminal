const { expect } = require("chai");
const { ethers } = require("hardhat");

const ONE = 10n ** 8n;
const LOCK_AMOUNT = 125n * ONE;
const L2_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes("AITT-L2-182"));
const BSC_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes("AITT-BSC-56"));

let mintCounter = 0;

function operationId(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

async function deployGovernance(factory, owners, quorum, timelockDelay) {
  const Governance = await ethers.getContractFactory("Phase4Governance");
  const tx = await factory.createGovernance(owners, quorum, timelockDelay);
  const receipt = await tx.wait();
  const address = receipt.logs.find((log) => log.fragment && log.fragment.name === "GovernanceCreated").args.governance;
  return Governance.attach(address);
}

async function executeGoverned(ctx, functionName, args) {
  const data = ctx.verifier.interface.encodeFunctionData(functionName, args);
  const tx = await ctx.governance.propose(await ctx.verifier.getAddress(), 0, data);
  const receipt = await tx.wait();
  const id = receipt.logs.find((log) => log.fragment && log.fragment.name === "ProposalCreated").args.id;
  await ctx.governance.connect(ctx.signerA).approve(id);
  await ctx.governance.connect(ctx.signerB).approve(id);
  await ctx.governance.execute(id);
}

async function signAttestation(signer, verifier, fields) {
  const digest = await verifier.attestationDigest(
    fields.sourceDomain,
    fields.destinationDomain,
    fields.canonicalToken,
    fields.wrapper,
    fields.operationId,
    fields.nonce,
    fields.amount,
    fields.sender,
    fields.recipient,
    fields.sourceBlockHash,
    fields.expiry
  );
  return { address: signer.address, signature: await signer.signMessage(ethers.getBytes(digest)) };
}

async function sortedSignatures(verifier, signers, fields) {
  const attestations = await Promise.all(signers.map((signer) => signAttestation(signer, verifier, fields)));
  return attestations.sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase())).map((x) => x.signature);
}

describe("Phase 4 local bridge prototype", function () {
  async function fixture(configureLimits = true) {
    const [owner, user, recipient, signerA, signerB, signerC, observerD] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("Phase4MockToken");
    const token = await Token.deploy("AITT Local Canonical", "AITTL", 1_000n * ONE);
    await token.waitForDeployment();
    await token.transfer(user.address, 1_000n * ONE);

    const GovernanceFactory = await ethers.getContractFactory("Phase4GovernanceFactory");
    const governanceFactory = await GovernanceFactory.deploy();
    await governanceFactory.waitForDeployment();
    const Verifier = await ethers.getContractFactory("Phase4AttestationVerifier");
    const verifier = await Verifier.deploy([signerA.address, signerB.address, signerC.address], 2, await governanceFactory.getAddress());
    await verifier.waitForDeployment();

    const governance = await deployGovernance(
      governanceFactory, [owner.address, signerA.address, signerB.address], 2, 0
    );
    await verifier.bootstrap(
      await governance.getAddress(), ethers.keccak256(ethers.toUtf8Bytes("AITT-PHASE4-LOCAL")), 1, 182, 56
    );

    const Escrow = await ethers.getContractFactory("Phase4Escrow");
    const escrow = await Escrow.deploy(
      await token.getAddress(),
      await verifier.getAddress(),
      L2_DOMAIN,
      BSC_DOMAIN
    );
    await escrow.waitForDeployment();

    const Wrapper = await ethers.getContractFactory("Phase4Wrapper");
    const wrapper = await Wrapper.deploy(
      "AITT BSC Local Wrapper",
      "wAITT",
      await verifier.getAddress(),
      L2_DOMAIN,
      BSC_DOMAIN,
      await token.getAddress(),
      await escrow.getAddress()
    );
    await wrapper.waitForDeployment();
    await verifier.setSourceContracts(await escrow.getAddress(), await wrapper.getAddress());
    if (configureLimits) {
      await executeGoverned({ verifier, governance, signerA, signerB }, "setLimits", [10_000n * ONE, 10_000n * ONE, 86400]);
    }

    await token.connect(user).approve(await escrow.getAddress(), ethers.MaxUint256);
    return { owner, user, recipient, signerA, signerB, signerC, observerD, token, verifier, governance, escrow, wrapper };
  }

  async function validMint(ctx, overrides = {}) {
    const { token, wrapper, recipient, user, verifier, signerA, signerB } = ctx;
    const latest = await ethers.provider.getBlock("latest");
    const fields = {
      sourceDomain: L2_DOMAIN,
      destinationDomain: BSC_DOMAIN,
      canonicalToken: await token.getAddress(),
      wrapper: await wrapper.getAddress(),
      operationId: operationId(`mint-${++mintCounter}`),
      nonce: 1n,
      amount: LOCK_AMOUNT,
      sender: user.address,
      recipient: recipient.address,
      sourceBlockHash: latest.hash,
      expiry: BigInt(latest.timestamp + 3600),
      eventTxHash: operationId("event-tx"),
      eventLogIndex: 0n,
      ...overrides,
    };
    await ctx.escrow.connect(user).lock(fields.amount, fields.recipient, fields.operationId);
    await ctx.escrow.setRemoteWrapper(await wrapper.getAddress());
    await ctx.escrow.registerLockProofWithEvent(fields.operationId, fields.nonce, fields.sourceBlockHash, fields.expiry, fields.eventTxHash, fields.eventLogIndex);
    if (!overrides.skipFinalize) await executeGoverned(ctx, "finalizeLockProof", [fields.operationId]);
    return { fields, signatures: await sortedSignatures(verifier, [signerA, signerB], fields) };
  }

  it("locks canonical AITT and mints the exact amount once on the wrapper", async function () {
    const ctx = await fixture();
    const { user, recipient, signerA, signerB, token, verifier, escrow, wrapper } = ctx;
    const id = operationId("lock-1");
    const tx = await escrow.connect(user).lock(LOCK_AMOUNT, recipient.address, id);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);

    const fields = {
      sourceDomain: L2_DOMAIN,
      destinationDomain: BSC_DOMAIN,
      canonicalToken: await token.getAddress(),
      wrapper: await wrapper.getAddress(),
      operationId: id,
      nonce: 1n,
      amount: LOCK_AMOUNT,
      sender: user.address,
      recipient: recipient.address,
      sourceBlockHash: block.hash,
      expiry: BigInt(block.timestamp + 3600),
    };
    const signatures = await sortedSignatures(verifier, [signerA, signerB], fields);

    await escrow.setRemoteWrapper(await wrapper.getAddress());
    await escrow.registerLockProof(id, fields.nonce, fields.sourceBlockHash, fields.expiry);
    await executeGoverned(ctx, "finalizeLockProof", [id]);
    await expect(wrapper.mintFromLock(fields, signatures))
      .to.emit(wrapper, "BridgeMinted")
      .withArgs(id, recipient.address, LOCK_AMOUNT);

    expect(await token.balanceOf(await escrow.getAddress())).to.equal(LOCK_AMOUNT);
    expect(await escrow.lockedAccounting()).to.equal(LOCK_AMOUNT);
    expect(await wrapper.balanceOf(recipient.address)).to.equal(LOCK_AMOUNT);
    expect(await wrapper.mintedAccounting()).to.equal(LOCK_AMOUNT);
    expect(await wrapper.burnedAccounting()).to.equal(0n);
    await expect(escrow.connect(user).lock(LOCK_AMOUNT, recipient.address, id)).to.be.revertedWith("operation-consumed");
    await expect(wrapper.mintFromLock(fields, signatures)).to.be.revertedWith("operation-consumed");
  });

  it("rejects wrong domain, token, and wrapper attestations", async function () {
    for (const [field, value, reason] of [
      ["sourceDomain", BSC_DOMAIN, "wrong-source-domain"],
      ["destinationDomain", L2_DOMAIN, "wrong-destination-domain"],
      ["canonicalToken", ethers.ZeroAddress, "wrong-canonical-token"],
      ["wrapper", ethers.ZeroAddress, "wrong-wrapper"],
    ]) {
      const ctx = await fixture();
      const { fields, signatures } = await validMint(ctx, { [field]: value });
      await expect(ctx.wrapper.mintFromLock(fields, signatures)).to.be.revertedWith(reason);
    }
  });

  it("rejects invalid verifier thresholds", async function () {
    const [signer] = await ethers.getSigners();
    const Verifier = await ethers.getContractFactory("Phase4AttestationVerifier");
    const GovernanceFactory = await ethers.getContractFactory("Phase4GovernanceFactory");
    const governanceFactory = await GovernanceFactory.deploy();
    await governanceFactory.waitForDeployment();
    await expect(Verifier.deploy([], 0, await governanceFactory.getAddress())).to.be.revertedWith("invalid-quorum");
    await expect(Verifier.deploy([signer.address], 2, await governanceFactory.getAddress())).to.be.revertedWith("invalid-quorum");
    await expect(Verifier.deploy([signer.address, signer.address], 1, await governanceFactory.getAddress())).to.be.revertedWith("invalid-signer");
  });

  it("rejects EOA, arbitrary contracts, and marker-spoofing contracts as governance controllers", async function () {
    const [owner, signerA, signerB] = await ethers.getSigners();
    const Verifier = await ethers.getContractFactory("Phase4AttestationVerifier");
    const GovernanceFactory = await ethers.getContractFactory("Phase4GovernanceFactory");
    const governanceFactory = await GovernanceFactory.deploy();
    await governanceFactory.waitForDeployment();
    const verifier = await Verifier.deploy([signerA.address, signerB.address], 2, await governanceFactory.getAddress());
    await verifier.waitForDeployment();
    const Token = await ethers.getContractFactory("Phase4MockToken");
    const arbitraryContract = await Token.deploy("arbitrary", "ARB", 1n);
    await arbitraryContract.waitForDeployment();
    const MarkerSpoof = await ethers.getContractFactory("Phase4MarkerSpoof");
    const markerSpoof = await MarkerSpoof.deploy();
    await markerSpoof.waitForDeployment();
    const protocol = ethers.keccak256(ethers.toUtf8Bytes("AITT-PHASE4-LOCAL"));
    await expect(verifier.bootstrap(signerA.address, protocol, 1, 182, 56))
      .to.be.revertedWith("invalid-governance-controller");
    await expect(verifier.bootstrap(await arbitraryContract.getAddress(), protocol, 1, 182, 56))
      .to.be.revertedWith("invalid-governance-controller");
    await expect(verifier.bootstrap(await markerSpoof.getAddress(), protocol, 1, 182, 56))
      .to.be.revertedWith("invalid-governance-controller");
    await expect(verifier.connect(owner).setGovernance(signerA.address))
      .to.be.revertedWith("invalid-governance-controller");
  });

  it("rejects bridge execution until positive limits are configured", async function () {
    const ctx = await fixture(false);
    const prepared = await validMint(ctx);
    await expect(ctx.wrapper.mintFromLock(prepared.fields, prepared.signatures)).to.be.revertedWith("limits-not-configured");
  });

  it("allows positive message and daily limits exactly at both boundaries", async function () {
    const ctx = await fixture(false);
    await executeGoverned(ctx, "setLimits", [LOCK_AMOUNT, LOCK_AMOUNT, 86400]);
    const prepared = await validMint(ctx, { amount: LOCK_AMOUNT });
    await expect(ctx.wrapper.mintFromLock(prepared.fields, prepared.signatures)).to.emit(ctx.wrapper, "BridgeMinted");
  });

  it("enforces pause, expiry, and strictly increasing mint nonces", async function () {
    const ctx = await fixture();
    const { owner, wrapper } = ctx;
    const pausedMint = await validMint(ctx);
    await wrapper.connect(owner).pause();
    await expect(wrapper.mintFromLock(pausedMint.fields, pausedMint.signatures))
      .to.be.revertedWithCustomError(wrapper, "EnforcedPause");

    await wrapper.connect(owner).unpause();
    const expired = await validMint(ctx, { expiry: 0n });
    await expect(wrapper.mintFromLock(expired.fields, expired.signatures)).to.be.revertedWith("attestation-expired");

    const first = await validMint(ctx, { nonce: 1n });
    await wrapper.mintFromLock(first.fields, first.signatures);
    const repeatedNonce = await validMint(ctx, { nonce: 1n });
    await expect(wrapper.mintFromLock(repeatedNonce.fields, repeatedNonce.signatures)).to.be.revertedWith("nonce-not-monotonic");
  });

  it("rejects reusing a lock operation ID for a burn", async function () {
    const ctx = await fixture();
    const operation = operationId("cross-direction-collision");
    const prepared = await validMint(ctx, { operationId: operation });
    await ctx.wrapper.mintFromLock(prepared.fields, prepared.signatures);
    await expect(ctx.wrapper.connect(ctx.recipient).burnAndRelease(LOCK_AMOUNT, ctx.user.address, operation))
      .to.be.revertedWith("operation-id-already-used");
  });

  it("pauses canonical locking and conserves supply across a complete round trip", async function () {
    const ctx = await fixture();
    const { owner, user, recipient, token, escrow, wrapper, verifier, signerA, signerB } = ctx;
    await escrow.connect(owner).pause();
    await expect(escrow.connect(user).lock(LOCK_AMOUNT, recipient.address, operationId("paused-lock")))
      .to.be.revertedWithCustomError(escrow, "EnforcedPause");
    await escrow.connect(owner).unpause();

    const initialSupply = await token.totalSupply();
    await escrow.connect(user).lock(LOCK_AMOUNT, recipient.address, operationId("conservation-lock"));
    const lockBlock = await ethers.provider.getBlock("latest");
    const lockFields = {
      sourceDomain: L2_DOMAIN,
      destinationDomain: BSC_DOMAIN,
      canonicalToken: await token.getAddress(),
      wrapper: await wrapper.getAddress(),
      operationId: operationId("conservation-lock"),
      nonce: 1n,
      amount: LOCK_AMOUNT,
      sender: user.address,
      recipient: recipient.address,
      sourceBlockHash: lockBlock.hash,
      expiry: BigInt(lockBlock.timestamp + 3600),
    };
    await escrow.setRemoteWrapper(await wrapper.getAddress());
    await escrow.registerLockProof(lockFields.operationId, lockFields.nonce, lockFields.sourceBlockHash, lockFields.expiry);
    await executeGoverned(ctx, "finalizeLockProof", [lockFields.operationId]);
    await wrapper.mintFromLock(lockFields, await sortedSignatures(verifier, [signerA, signerB], lockFields));
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(LOCK_AMOUNT);
    expect(await wrapper.totalSupply()).to.equal(LOCK_AMOUNT);

    const burnId = operationId("conservation-burn");
    await wrapper.connect(recipient).burnAndRelease(LOCK_AMOUNT, user.address, burnId);
    const burnBlock = await ethers.provider.getBlock("latest");
    const releaseFields = {
      sourceDomain: BSC_DOMAIN,
      destinationDomain: L2_DOMAIN,
      canonicalToken: await token.getAddress(),
      wrapper: await wrapper.getAddress(),
      operationId: burnId,
      nonce: 1n,
      amount: LOCK_AMOUNT,
      sender: recipient.address,
      recipient: user.address,
      sourceBlockHash: burnBlock.hash,
      expiry: BigInt(burnBlock.timestamp + 3600),
    };
    await escrow.setRemoteWrapper(await wrapper.getAddress());
    await wrapper.registerBurnProof(releaseFields.operationId, releaseFields.nonce, releaseFields.sourceBlockHash, releaseFields.expiry);
    await executeGoverned(ctx, "finalizeBurnProof", [releaseFields.operationId]);
    await escrow.releaseFromBurn(releaseFields, await sortedSignatures(verifier, [signerA, signerB], releaseFields));
    expect(await token.totalSupply()).to.equal(initialSupply);
    expect(await token.balanceOf(await escrow.getAddress())).to.equal(0n);
    expect(await escrow.lockedAccounting()).to.equal(0n);
    expect(await wrapper.totalSupply()).to.equal(0n);
    expect(await wrapper.mintedAccounting()).to.equal(LOCK_AMOUNT);
    expect(await wrapper.burnedAccounting()).to.equal(LOCK_AMOUNT);
  });

  it("requires a registered finalized lock proof before minting", async function () {
    const ctx = await fixture();
    const { token, wrapper, recipient, user, verifier, signerA, signerB, escrow } = ctx;
    const latest = await ethers.provider.getBlock("latest");
    const id = operationId("missing-proof");
    await escrow.connect(user).lock(LOCK_AMOUNT, recipient.address, id);
    await escrow.setRemoteWrapper(await wrapper.getAddress());
    const fields = { sourceDomain: L2_DOMAIN, destinationDomain: BSC_DOMAIN, canonicalToken: await token.getAddress(), wrapper: await wrapper.getAddress(), operationId: id, nonce: 1n, amount: LOCK_AMOUNT, sender: user.address, recipient: recipient.address, sourceBlockHash: latest.hash, expiry: BigInt(latest.timestamp + 3600) };
    const signatures = await sortedSignatures(verifier, [signerA, signerB], fields);
    await expect(wrapper.mintFromLock(fields, signatures)).to.be.revertedWith("lock-proof-not-registered");
  });

  it("rejects an unfinalized lock proof", async function () {
    const ctx = await fixture();
    const { fields, signatures } = await validMint(ctx);
    // Replace the finalized proof with a fresh operation whose source event is only registered.
    const id = operationId("unfinalized-lock");
    await ctx.escrow.connect(ctx.user).lock(LOCK_AMOUNT, ctx.recipient.address, id);
    fields.operationId = id;
    fields.sourceBlockHash = (await ethers.provider.getBlock("latest")).hash;
    fields.expiry = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    await ctx.escrow.registerLockProof(id, fields.nonce, fields.sourceBlockHash, fields.expiry);
    const freshSignatures = await sortedSignatures(ctx.verifier, [ctx.signerA, ctx.signerB], fields);
    await expect(ctx.wrapper.mintFromLock(fields, freshSignatures)).to.be.revertedWith("lock-proof-not-finalized");
  });

  it("rejects a signed message whose fields differ from the registered proof", async function () {
    const ctx = await fixture();
    const prepared = await validMint(ctx);
    const mutated = { ...prepared.fields, recipient: ctx.user.address };
    const signatures = await sortedSignatures(ctx.verifier, [ctx.signerA, ctx.signerB], mutated);
    await expect(ctx.wrapper.mintFromLock(mutated, signatures)).to.be.revertedWith("lock-proof-mismatch");
  });

  it("enforces escrow backing before minting additional wrapper supply", async function () {
    const ctx = await fixture();
    const prepared = await validMint(ctx);
    const overdrawn = { ...prepared.fields, amount: LOCK_AMOUNT + 1n };
    const signatures = await sortedSignatures(ctx.verifier, [ctx.signerA, ctx.signerB], overdrawn);
    await expect(ctx.wrapper.mintFromLock(overdrawn, signatures)).to.be.revertedWith("escrow-insolvent");
  });

  it("rejects a finalized burn proof when its signed fields are mutated", async function () {
    const ctx = await fixture();
    const { fields } = await validMint(ctx);
    await ctx.wrapper.mintFromLock(fields, await sortedSignatures(ctx.verifier, [ctx.signerA, ctx.signerB], fields));
    const burnId = operationId("mutated-burn");
    await ctx.wrapper.connect(ctx.recipient).burnAndRelease(LOCK_AMOUNT, ctx.user.address, burnId);
    const block = await ethers.provider.getBlock("latest");
    const release = { sourceDomain: BSC_DOMAIN, destinationDomain: L2_DOMAIN, canonicalToken: await ctx.token.getAddress(), wrapper: await ctx.wrapper.getAddress(), operationId: burnId, nonce: 2n, amount: LOCK_AMOUNT, sender: ctx.recipient.address, recipient: ctx.user.address, sourceBlockHash: block.hash, expiry: BigInt(block.timestamp + 3600) };
    await ctx.wrapper.registerBurnProof(burnId, release.nonce, release.sourceBlockHash, release.expiry);
    await executeGoverned(ctx, "finalizeBurnProof", [burnId]);
    const mutated = { ...release, amount: LOCK_AMOUNT - 1n };
    const signatures = await sortedSignatures(ctx.verifier, [ctx.signerA, ctx.signerB], mutated);
    await ctx.escrow.setRemoteWrapper(await ctx.wrapper.getAddress());
    await expect(ctx.escrow.releaseFromBurn(mutated, signatures)).to.be.revertedWith("burn-proof-mismatch");
  });

  it("burns wrapper AITT and releases the exact amount once on the canonical side", async function () {
    const ctx = await fixture();
    const { user, recipient, signerA, signerB, token, verifier, escrow, wrapper } = ctx;
    const id = operationId("lock-2");
    await escrow.connect(user).lock(LOCK_AMOUNT, recipient.address, id);
    const lockBlock = await ethers.provider.getBlock("latest");
    const lockFields = {
      sourceDomain: L2_DOMAIN,
      destinationDomain: BSC_DOMAIN,
      canonicalToken: await token.getAddress(),
      wrapper: await wrapper.getAddress(),
      operationId: id,
      nonce: 1n,
      amount: LOCK_AMOUNT,
      sender: user.address,
      recipient: recipient.address,
      sourceBlockHash: lockBlock.hash,
      expiry: BigInt(lockBlock.timestamp + 3600),
    };
    const lockSigs = await sortedSignatures(verifier, [signerA, signerB], lockFields);
    await escrow.setRemoteWrapper(await wrapper.getAddress());
    await escrow.registerLockProof(lockFields.operationId, lockFields.nonce, lockFields.sourceBlockHash, lockFields.expiry);
    await executeGoverned(ctx, "finalizeLockProof", [lockFields.operationId]);
    await wrapper.mintFromLock(lockFields, lockSigs);
    const burnId = operationId("burn-2");
    await wrapper.connect(recipient).burnAndRelease(LOCK_AMOUNT, user.address, burnId);
    const burnBlock = await ethers.provider.getBlock("latest");
    const releaseFields = {
      sourceDomain: BSC_DOMAIN,
      destinationDomain: L2_DOMAIN,
      canonicalToken: await token.getAddress(),
      wrapper: await wrapper.getAddress(),
      operationId: burnId,
      nonce: 2n,
      amount: LOCK_AMOUNT,
      sender: recipient.address,
      recipient: user.address,
      sourceBlockHash: burnBlock.hash,
      expiry: BigInt(burnBlock.timestamp + 3600),
    };
    const releaseSigs = await sortedSignatures(verifier, [signerA, signerB], releaseFields);
    await wrapper.registerBurnProof(releaseFields.operationId, releaseFields.nonce, releaseFields.sourceBlockHash, releaseFields.expiry);
    await executeGoverned(ctx, "finalizeBurnProof", [releaseFields.operationId]);

    await expect(escrow.releaseFromBurn(releaseFields, releaseSigs))
      .to.emit(escrow, "BridgeReleased")
      .withArgs(burnId, user.address, LOCK_AMOUNT);
    expect(await wrapper.totalSupply()).to.equal(0n);
    expect(await token.balanceOf(user.address)).to.equal(1_000n * ONE);
    await expect(escrow.releaseFromBurn(releaseFields, releaseSigs)).to.be.revertedWith("operation-consumed");
    await expect(wrapper.connect(recipient).burnAndRelease(1n, user.address, burnId)).to.be.revertedWith("operation-consumed");
  });

  describe("Slice 1 local governance and safety controls", function () {
    it("binds attestations to protocol/version/chains and bridge instance", async function () {
      const ctx = await fixture();
      const digest = await ctx.verifier.attestationDigest(
        L2_DOMAIN, BSC_DOMAIN, await ctx.token.getAddress(), await ctx.wrapper.getAddress(),
        operationId("binding"), 1n, LOCK_AMOUNT, ctx.user.address, ctx.recipient.address,
        ethers.ZeroHash, 9999999999n
      );
      await executeGoverned(ctx, "configureMessageBinding", [
        ethers.keccak256(ethers.toUtf8Bytes("AITT-PHASE4-LOCAL")), 2, 182, 56
      ]);
      const rebound = await ctx.verifier.attestationDigest(
        L2_DOMAIN, BSC_DOMAIN, await ctx.token.getAddress(), await ctx.wrapper.getAddress(),
        operationId("binding"), 1n, LOCK_AMOUNT, ctx.user.address, ctx.recipient.address,
        ethers.ZeroHash, 9999999999n
      );
      expect(rebound).to.not.equal(digest);
      expect(await ctx.verifier.messageVersion()).to.equal(2n);
      expect(await ctx.verifier.sourceChainId()).to.equal(182n);
      expect(await ctx.verifier.destinationChainId()).to.equal(56n);
    });

    it("executes signer rotation only through quorum governance after a timelock", async function () {
      const [owner, signerA, signerB, signerC] = await ethers.getSigners();
      const GovernanceFactory = await ethers.getContractFactory("Phase4GovernanceFactory");
      const governanceFactory = await GovernanceFactory.deploy();
      await governanceFactory.waitForDeployment();
      const governance = await deployGovernance(
        governanceFactory, [owner.address, signerA.address, signerB.address, signerC.address], 2, 3600
      );
      const Verifier = await ethers.getContractFactory("Phase4AttestationVerifier");
      const verifier = await Verifier.deploy([signerA.address, signerB.address], 2, await governanceFactory.getAddress());
      await verifier.waitForDeployment();
      await verifier.setGovernance(await governance.getAddress());
      const data = verifier.interface.encodeFunctionData("rotateSigner", [signerA.address, signerC.address]);
      const tx = await governance.propose(await verifier.getAddress(), 0, data);
      const receipt = await tx.wait();
      const proposalId = receipt.logs.find((log) => log.fragment && log.fragment.name === "ProposalCreated").args.id;
      await governance.connect(signerA).approve(proposalId);
      await governance.connect(signerB).approve(proposalId);
      await expect(governance.execute(proposalId)).to.be.revertedWith("timelock-active");
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine");
      await governance.execute(proposalId);
      expect(await verifier.isSigner(signerA.address)).to.equal(false);
      expect(await verifier.isSigner(signerC.address)).to.equal(true);
      const digest = await verifier.attestationDigest(
        L2_DOMAIN, BSC_DOMAIN, ethers.ZeroAddress, ethers.ZeroAddress,
        operationId("rotated-signer"), 1n, 1n, owner.address, signerC.address, ethers.ZeroHash, 9999999999n
      );
      const oldAndNew = [
        { address: signerA.address, signature: await signerA.signMessage(ethers.getBytes(digest)) },
        { address: signerC.address, signature: await signerC.signMessage(ethers.getBytes(digest)) },
      ].sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase())).map((x) => x.signature);
      await expect(verifier.verify(digest, oldAndNew)).to.be.revertedWith("unauthorized-signer");

      const revokeData = verifier.interface.encodeFunctionData("revokeSigner", [signerB.address]);
      const revokeTx = await governance.propose(await verifier.getAddress(), 0, revokeData);
      const revokeReceipt = await revokeTx.wait();
      const revokeId = revokeReceipt.logs.find((log) => log.fragment && log.fragment.name === "ProposalCreated").args.id;
      await expect(governance.connect(signerA).approve(revokeId)).to.be.revertedWith("inactive-governance-signer");
    });

    it("rejects the owner bypass for security-sensitive verifier configuration", async function () {
      const ctx = await fixture();
      await expect(ctx.verifier.connect(ctx.owner).configureMessageBinding(
        ethers.keccak256(ethers.toUtf8Bytes("replacement")), 2, 182, 56
      )).to.be.revertedWith("governance-required");
      await expect(ctx.verifier.connect(ctx.owner).setLimits(LOCK_AMOUNT, LOCK_AMOUNT, 86400))
        .to.be.revertedWith("governance-required");
    });

    it("rejects bridge execution until a nonzero binding is activated", async function () {
      const [, signerA, signerB] = await ethers.getSigners();
      const Verifier = await ethers.getContractFactory("Phase4AttestationVerifier");
      const GovernanceFactory = await ethers.getContractFactory("Phase4GovernanceFactory");
    const governanceFactory = await GovernanceFactory.deploy();
    await governanceFactory.waitForDeployment();
    const verifier = await Verifier.deploy([signerA.address, signerB.address], 2, await governanceFactory.getAddress());
      await verifier.waitForDeployment();
      expect(await verifier.bindingActive()).to.equal(false);
      expect(await verifier.sourceChainId()).to.equal(0n);
      expect(await verifier.destinationChainId()).to.equal(0n);
    });

    it("rejects a revoked signer from approving verifier governance proposals", async function () {
      const [owner, signerA, signerB, signerC] = await ethers.getSigners();
      const GovernanceFactory = await ethers.getContractFactory("Phase4GovernanceFactory");
      const governanceFactory = await GovernanceFactory.deploy();
      await governanceFactory.waitForDeployment();
      const governance = await deployGovernance(
        governanceFactory, [owner.address, signerA.address, signerB.address, signerC.address], 2, 0
      );
      const Verifier = await ethers.getContractFactory("Phase4AttestationVerifier");
      const verifier = await Verifier.deploy([signerA.address, signerB.address, signerC.address], 2, await governanceFactory.getAddress());
      await verifier.waitForDeployment();
      await verifier.setGovernance(await governance.getAddress());
      const revokeData = verifier.interface.encodeFunctionData("revokeSigner", [signerB.address]);
      const revokeTx = await governance.connect(owner).propose(await verifier.getAddress(), 0, revokeData);
      const revokeReceipt = await revokeTx.wait();
      const revokeId = revokeReceipt.logs.find((log) => log.fragment && log.fragment.name === "ProposalCreated").args.id;
      await governance.connect(signerA).approve(revokeId);
      await governance.connect(signerB).approve(revokeId);
      await governance.execute(revokeId);
      const configData = verifier.interface.encodeFunctionData("configureMessageBinding", [
        ethers.keccak256(ethers.toUtf8Bytes("governed")), 1, 182, 56
      ]);
      const configTx = await governance.connect(owner).propose(await verifier.getAddress(), 0, configData);
      const configReceipt = await configTx.wait();
      const configId = configReceipt.logs.find((log) => log.fragment && log.fragment.name === "ProposalCreated").args.id;
      await expect(governance.connect(signerB).approve(configId)).to.be.revertedWith("inactive-governance-signer");
      await governance.connect(signerA).approve(configId);
      await expect(governance.execute(configId)).to.be.revertedWith("quorum-not-reached");
      expect(await verifier.isSigner(signerB.address)).to.equal(false);
    });

    it("enforces message and rolling daily limits and recovers after the window", async function () {
      const ctx = await fixture();
      await executeGoverned(ctx, "setLimits", [LOCK_AMOUNT * 2n, LOCK_AMOUNT * 2n, 86400]);
      const first = await validMint(ctx, { amount: LOCK_AMOUNT });
      await ctx.wrapper.mintFromLock(first.fields, first.signatures);
      const excessMessage = await validMint(ctx, { amount: LOCK_AMOUNT * 2n + 1n, nonce: 2n });
      await expect(ctx.wrapper.mintFromLock(excessMessage.fields, excessMessage.signatures)).to.be.revertedWith("message-limit");
      const dailyExcess = await validMint(ctx, { amount: LOCK_AMOUNT + 1n, nonce: 3n });
      await expect(ctx.wrapper.mintFromLock(dailyExcess.fields, dailyExcess.signatures)).to.be.revertedWith("daily-limit");
      await ethers.provider.send("evm_increaseTime", [86401]);
      await ethers.provider.send("evm_mine");
      const recovered = await validMint(ctx, { amount: LOCK_AMOUNT, nonce: 4n });
      await expect(ctx.wrapper.mintFromLock(recovered.fields, recovered.signatures)).to.emit(ctx.wrapper, "BridgeMinted");
    });
  });

  describe("Slice 2 local recovery and reconciliation", function () {
    it("tracks lock operation lifecycle and refunds an expired lock exactly once to its bound sender", async function () {
      const ctx = await fixture();
      const prepared = await validMint(ctx, { expiry: 1n });
      expect(await ctx.escrow.operationState(prepared.fields.operationId)).to.equal(2n);
      await expect(ctx.escrow.refundLock(prepared.fields.operationId, prepared.fields.recipient))
        .to.emit(ctx.escrow, "LockRefunded")
        .withArgs(prepared.fields.operationId, ctx.user.address, LOCK_AMOUNT);
      expect(await ctx.escrow.operationState(prepared.fields.operationId)).to.equal(8n);
      await expect(ctx.escrow.refundLock(prepared.fields.operationId, prepared.fields.recipient)).to.be.revertedWith("operation-refunded");
      expect(await ctx.escrow.lockedAccounting()).to.equal(0n);
    });

    it("rejects a lock refund before expiry, with a wrong recipient, or after mint", async function () {
      const ctx = await fixture();
      const prepared = await validMint(ctx);
      await expect(ctx.escrow.refundLock(prepared.fields.operationId, prepared.fields.recipient)).to.be.revertedWith("lock-not-refundable");
      await expect(ctx.escrow.refundLock(prepared.fields.operationId, ctx.user.address)).to.be.revertedWith("recipient-mismatch");
      await ctx.wrapper.mintFromLock(prepared.fields, prepared.signatures);
      await expect(ctx.escrow.refundLock(prepared.fields.operationId, prepared.fields.recipient)).to.be.revertedWith("lock-not-refundable");
    });

    it("recovers an expired burn exactly once to the original burner and never to an arbitrary recipient", async function () {
      const ctx = await fixture();
      const prepared = await validMint(ctx);
      await ctx.wrapper.mintFromLock(prepared.fields, prepared.signatures);
      const burnId = operationId("slice2-recover-burn");
      await ctx.wrapper.connect(ctx.recipient).burnAndRelease(LOCK_AMOUNT, ctx.user.address, burnId);
      const block = await ethers.provider.getBlock("latest");
      const release = { sourceDomain: BSC_DOMAIN, destinationDomain: L2_DOMAIN, canonicalToken: await ctx.token.getAddress(), wrapper: await ctx.wrapper.getAddress(), operationId: burnId, nonce: 2n, amount: LOCK_AMOUNT, sender: ctx.recipient.address, recipient: ctx.user.address, sourceBlockHash: block.hash, expiry: 1n };
      await ctx.wrapper.registerBurnProof(burnId, release.nonce, release.sourceBlockHash, release.expiry);
      await expect(ctx.wrapper.recoverBurn(burnId)).to.emit(ctx.wrapper, "BurnRecovered").withArgs(burnId, ctx.recipient.address, LOCK_AMOUNT);
      expect(await ctx.wrapper.balanceOf(ctx.recipient.address)).to.equal(LOCK_AMOUNT);
      await expect(ctx.wrapper.recoverBurn(burnId)).to.be.revertedWith("burn-already-recovered");
    });

    it("rejects burn recovery after release, while reconciliation stays exact", async function () {
      const ctx = await fixture();
      const prepared = await validMint(ctx);
      await ctx.wrapper.mintFromLock(prepared.fields, prepared.signatures);
      const burnId = operationId("slice2-released-burn");
      await ctx.wrapper.connect(ctx.recipient).burnAndRelease(LOCK_AMOUNT, ctx.user.address, burnId);
      const block = await ethers.provider.getBlock("latest");
      const release = { sourceDomain: BSC_DOMAIN, destinationDomain: L2_DOMAIN, canonicalToken: await ctx.token.getAddress(), wrapper: await ctx.wrapper.getAddress(), operationId: burnId, nonce: 2n, amount: LOCK_AMOUNT, sender: ctx.recipient.address, recipient: ctx.user.address, sourceBlockHash: block.hash, expiry: BigInt(block.timestamp + 3600) };
      await ctx.wrapper.registerBurnProof(burnId, release.nonce, release.sourceBlockHash, release.expiry);
      await executeGoverned(ctx, "finalizeBurnProof", [burnId]);
      await ctx.escrow.releaseFromBurn(release, await sortedSignatures(ctx.verifier, [ctx.signerA, ctx.signerB], release));
      await expect(ctx.wrapper.recoverBurn(burnId)).to.be.revertedWith("burn-not-recoverable");
      expect(await ctx.escrow.isReconciled()).to.equal(true);
      expect(await ctx.wrapper.isReconciled()).to.equal(true);
      await expect(ctx.escrow.assertReconciled()).to.not.be.reverted;
      await expect(ctx.wrapper.assertReconciled()).to.not.be.reverted;
    });

    it("supports governance-marked failure and keeps recovery paused or non-refundable at the exact expiry boundary", async function () {
      const ctx = await fixture();
      const prepared = await validMint(ctx, { expiry: 1n });
      await executeGoverned(ctx, "markLockProofFailed", [prepared.fields.operationId]);
      await ctx.escrow.pause();
      await expect(ctx.escrow.refundLock(prepared.fields.operationId, prepared.fields.recipient)).to.be.revertedWithCustomError(ctx.escrow, "EnforcedPause");
      await ctx.escrow.unpause();
      await expect(ctx.escrow.refundLock(prepared.fields.operationId, prepared.fields.recipient)).to.emit(ctx.escrow, "LockRefunded");

      const boundary = await ethers.provider.getBlock("latest");
      const second = await validMint(ctx, { expiry: BigInt(boundary.timestamp + 100) });
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(second.fields.expiry)]);
      await expect(ctx.escrow.refundLock(second.fields.operationId, second.fields.recipient)).to.be.revertedWith("lock-not-refundable");
    });

    it("makes a governance-failed lock terminally non-executable before and after refund", async function () {
      const ctx = await fixture();
      const prepared = await validMint(ctx);
      await executeGoverned(ctx, "markLockProofFailed", [prepared.fields.operationId]);

      await expect(ctx.wrapper.mintFromLock(prepared.fields, prepared.signatures))
        .to.be.revertedWith("lock-proof-failed");
      expect(await ctx.wrapper.totalSupply()).to.equal(0n);
      expect(await ctx.escrow.lockedAccounting()).to.equal(LOCK_AMOUNT);

      await expect(ctx.escrow.refundLock(prepared.fields.operationId, prepared.fields.recipient))
        .to.emit(ctx.escrow, "LockRefunded");
      expect(await ctx.escrow.lockedAccounting()).to.equal(0n);
      expect(await ctx.verifier.lockProofRecoverable(prepared.fields.operationId)).to.equal(false);
      expect(await ctx.verifier.failedLockProofs(prepared.fields.operationId)).to.equal(true);
      await expect(ctx.wrapper.mintFromLock(prepared.fields, prepared.signatures))
        .to.be.revertedWith("escrow-insolvent");
      expect(await ctx.wrapper.totalSupply()).to.equal(0n);
    });

    it("makes a governance-failed burn terminally non-executable before and after recovery", async function () {
      const ctx = await fixture();
      const prepared = await validMint(ctx);
      await ctx.wrapper.mintFromLock(prepared.fields, prepared.signatures);
      const burnId = operationId("slice2-failed-burn");
      await ctx.wrapper.connect(ctx.recipient).burnAndRelease(LOCK_AMOUNT, ctx.user.address, burnId);
      const block = await ethers.provider.getBlock("latest");
      const release = {
        sourceDomain: BSC_DOMAIN,
        destinationDomain: L2_DOMAIN,
        canonicalToken: await ctx.token.getAddress(),
        wrapper: await ctx.wrapper.getAddress(),
        operationId: burnId,
        nonce: 2n,
        amount: LOCK_AMOUNT,
        sender: ctx.recipient.address,
        recipient: ctx.user.address,
        sourceBlockHash: block.hash,
        expiry: BigInt(block.timestamp + 3600),
      };
      await ctx.wrapper.registerBurnProof(burnId, release.nonce, release.sourceBlockHash, release.expiry);
      await executeGoverned(ctx, "finalizeBurnProof", [burnId]);
      await executeGoverned(ctx, "markBurnProofFailed", [burnId]);
      const signatures = await sortedSignatures(ctx.verifier, [ctx.signerA, ctx.signerB], release);

      await expect(ctx.escrow.releaseFromBurn(release, signatures))
        .to.be.revertedWith("burn-proof-failed");
      expect(await ctx.token.balanceOf(await ctx.escrow.getAddress())).to.equal(LOCK_AMOUNT);
      expect(await ctx.escrow.lockedAccounting()).to.equal(LOCK_AMOUNT);

      await expect(ctx.wrapper.recoverBurn(burnId))
        .to.emit(ctx.wrapper, "BurnRecovered");
      expect(await ctx.wrapper.balanceOf(ctx.recipient.address)).to.equal(LOCK_AMOUNT);
      expect(await ctx.verifier.burnProofRecoverable(burnId)).to.equal(false);
      await expect(ctx.escrow.releaseFromBurn(release, signatures))
        .to.be.revertedWith("burn-proof-failed");
      expect(await ctx.token.balanceOf(await ctx.escrow.getAddress())).to.equal(LOCK_AMOUNT);
      expect(await ctx.escrow.lockedAccounting()).to.equal(LOCK_AMOUNT);
      expect(await ctx.wrapper.totalSupply()).to.equal(LOCK_AMOUNT);
    });

    it("rolls back refund attempts that fail recipient binding without changing accounting", async function () {
      const ctx = await fixture();
      const prepared = await validMint(ctx, { expiry: 1n });
      await expect(ctx.escrow.refundLock(prepared.fields.operationId, ctx.user.address)).to.be.revertedWith("recipient-mismatch");
      expect(await ctx.escrow.lockedAccounting()).to.equal(LOCK_AMOUNT);
      expect(await ctx.verifier.lockProofRecoverable(prepared.fields.operationId)).to.equal(true);
    });
  });

  describe("Slice 3 local finality, reorg, and observer disagreement", function () {
    async function configureFinality(ctx, observerQuorum = 2, staleDepth = 2) {
      await executeGoverned(ctx, "configureFinality", [observerQuorum, staleDepth]);
    }

    async function observe(ctx, observers, number, hash, root, operationId = ethers.ZeroHash) {
      for (const observer of observers) {
        await ctx.verifier.connect(observer).registerSourceHeader(observer.address, number, hash, ethers.ZeroHash, root);
        if (operationId !== ethers.ZeroHash) {
          await ctx.verifier.connect(observer).registerSourceEvent(observer.address, operationId, number, hash);
          await ctx.verifier.connect(observer).registerSourceEventBinding(
            observer.address, operationId, number, hash,
            await ctx.escrow.getAddress(), ethers.id("Locked(bytes32,address,address,uint256)"),
            operationId, 0, LOCK_AMOUNT, ctx.recipient.address
          );
        }
      }
    }

    it("requires the observer quorum boundary and matching canonical head before finalization", async function () {
      const ctx = await fixture();
      const hash = operationId("slice3-head-a");
      const root = operationId("slice3-root-a");
      const prepared = await validMint(ctx, { sourceBlockHash: hash, skipFinalize: true });
      await configureFinality(ctx, 2, 2);
      await observe(ctx, [ctx.signerA], 10, hash, root, prepared.fields.operationId);
      await expect(executeGoverned(ctx, "finalizeLockProof", [prepared.fields.operationId]))
        .to.be.revertedWith("proposal-call-failed");
      await observe(ctx, [ctx.signerB], 10, hash, root, prepared.fields.operationId);
      await expect(executeGoverned(ctx, "finalizeLockProof", [prepared.fields.operationId])).to.not.be.reverted;
      expect(await ctx.verifier.finalizedBlockNumber(prepared.fields.operationId)).to.equal(10n);
      expect(await ctx.verifier.finalizedBlockRoot(prepared.fields.operationId)).to.equal(root);
    });

    it("fails closed on stale RPC heads and conflicting observer heads", async function () {
      const ctx = await fixture();
      const hashA = operationId("slice3-head-conflict-a");
      const hashB = operationId("slice3-head-conflict-b");
      const root = operationId("slice3-root-conflict");
      const prepared = await validMint(ctx, { sourceBlockHash: hashA, skipFinalize: true });
      await configureFinality(ctx, 2, 1);
      await observe(ctx, [ctx.signerA, ctx.signerB], 20, hashA, root, prepared.fields.operationId);
      await executeGoverned(ctx, "finalizeLockProof", [prepared.fields.operationId]);
      await expect(ctx.verifier.connect(ctx.signerC).registerSourceHeader(ctx.signerC.address, 18, hashB, ethers.ZeroHash, root))
        .to.be.revertedWith("stale-source-head");
      await ctx.verifier.connect(ctx.signerC).registerSourceHeader(ctx.signerC.address, 20, hashB, ethers.ZeroHash, root);
      await expect(ctx.verifier.reconcileCanonicalHead(20, hashB, root)).to.be.revertedWith("observer-disagreement");
    });

    it("rejects equal-sized competing quorum heads instead of selecting one", async function () {
      const ctx = await fixture();
      const hashA = operationId("slice3-equal-quorum-a");
      const hashB = operationId("slice3-equal-quorum-b");
      const root = operationId("slice3-equal-quorum-root");
      const prepared = await validMint(ctx, { sourceBlockHash: hashA, skipFinalize: true });
      await configureFinality(ctx, 2, 2);
      await observe(ctx, [ctx.signerA, ctx.signerB], 22, hashA, root, prepared.fields.operationId);
      await executeGoverned(ctx, "configureObserver", [ctx.observerD.address, true]);
      await observe(ctx, [ctx.signerC, ctx.observerD], 22, hashB, root);
      await expect(executeGoverned(ctx, "finalizeLockProof", [prepared.fields.operationId]))
        .to.be.revertedWith("proposal-call-failed");
    });

    it("verifies the complete source event binding during proof consumption", async function () {
      const ctx = await fixture();
      const hash = operationId("slice3-event-binding-head");
      const root = operationId("slice3-event-binding-root");
      const prepared = await validMint(ctx, { sourceBlockHash: hash, skipFinalize: true });
      await configureFinality(ctx, 2, 2);
      for (const observer of [ctx.signerA, ctx.signerB]) {
        await ctx.verifier.connect(observer).registerSourceHeader(observer.address, 23, hash, ethers.ZeroHash, root);
        await ctx.verifier.connect(observer).registerSourceEvent(observer.address, prepared.fields.operationId, 23, hash);
        await ctx.verifier.connect(observer).registerSourceEventBinding(
          observer.address, prepared.fields.operationId, 23, hash,
          await ctx.token.getAddress(), ethers.id("NotLocked(bytes32,address,address,uint256)"),
          operationId("event-tx"), 7, LOCK_AMOUNT, ctx.recipient.address
        );
      }
      await expect(executeGoverned(ctx, "finalizeLockProof", [prepared.fields.operationId])).to.not.be.reverted;
      await expect(ctx.wrapper.mintFromLock(prepared.fields, await sortedSignatures(ctx.verifier, [ctx.signerA, ctx.signerB], prepared.fields), prepared.fields.eventTxHash, prepared.fields.eventLogIndex))
        .to.be.revertedWith("event-binding-mismatch");
    });

    it("rejects equal-sized competing quorum heads during canonical reconciliation", async function () {
      const ctx = await fixture();
      const hashA = operationId("slice3-reconcile-equal-a");
      const hashB = operationId("slice3-reconcile-equal-b");
      const root = operationId("slice3-reconcile-equal-root");
      await configureFinality(ctx, 2, 2);
      await observe(ctx, [ctx.signerA, ctx.signerB], 24, hashA, root);
      await executeGoverned(ctx, "configureObserver", [ctx.observerD.address, true]);
      await observe(ctx, [ctx.signerC, ctx.observerD], 24, hashB, root);
      await expect(ctx.verifier.reconcileCanonicalHead(24, hashA, root)).to.be.revertedWith("observer-head-disagreement");
    });

    it("rejects a source event transaction or log index that differs at consumption", async function () {
      const ctx = await fixture();
      const hash = operationId("slice3-event-identity-head");
      const root = operationId("slice3-event-identity-root");
      const prepared = await validMint(ctx, { sourceBlockHash: hash, skipFinalize: true });
      await configureFinality(ctx, 2, 2);
      await observe(ctx, [ctx.signerA, ctx.signerB], 25, hash, root, prepared.fields.operationId);
      await executeGoverned(ctx, "finalizeLockProof", [prepared.fields.operationId]);
      const signatures = await sortedSignatures(ctx.verifier, [ctx.signerA, ctx.signerB], prepared.fields);
      await expect(ctx.wrapper.mintFromLock(
        prepared.fields, signatures, prepared.fields.eventTxHash, prepared.fields.eventLogIndex + 1n
      )).to.be.revertedWith("event-binding-mismatch");
    });

    it("rejects observer event identity that differs from the registered source proof", async function () {
      const ctx = await fixture();
      const hash = operationId("slice3-proof-identity-head");
      const root = operationId("slice3-proof-identity-root");
      const prepared = await validMint(ctx, {
        sourceBlockHash: hash,
        eventTxHash: operationId("proof-event-tx"),
        eventLogIndex: 3n,
        skipFinalize: true,
      });
      await configureFinality(ctx, 2, 2);
      const observerEventTxHash = operationId("observer-event-tx");
      for (const observer of [ctx.signerA, ctx.signerB]) {
        await ctx.verifier.connect(observer).registerSourceHeader(observer.address, 26, hash, ethers.ZeroHash, root);
        await ctx.verifier.connect(observer).registerSourceEvent(observer.address, prepared.fields.operationId, 26, hash);
        await ctx.verifier.connect(observer).registerSourceEventBinding(
          observer.address, prepared.fields.operationId, 26, hash, await ctx.escrow.getAddress(),
          ethers.id("Locked(bytes32,address,address,uint256)"), observerEventTxHash,
          3, LOCK_AMOUNT, ctx.recipient.address
        );
      }
      await executeGoverned(ctx, "finalizeLockProof", [prepared.fields.operationId]);
      const signatures = await sortedSignatures(ctx.verifier, [ctx.signerA, ctx.signerB], prepared.fields);
      await expect(ctx.wrapper.mintFromLock(
        prepared.fields, signatures, observerEventTxHash, 3
      )).to.be.revertedWith("event-binding-mismatch");
    });

    it("checks burn event identity during finalized release consumption", async function () {
      const ctx = await fixture();
      const prepared = await validMint(ctx);
      await ctx.wrapper.mintFromLock(prepared.fields, prepared.signatures);
      const burnId = operationId("slice3-burn-event-identity");
      await ctx.wrapper.connect(ctx.recipient).burnAndRelease(LOCK_AMOUNT, ctx.user.address, burnId);
      const block = await ethers.provider.getBlock("latest");
      const burnTxHash = operationId("slice3-burn-event-tx");
      const release = {
        sourceDomain: BSC_DOMAIN, destinationDomain: L2_DOMAIN,
        canonicalToken: await ctx.token.getAddress(), wrapper: await ctx.wrapper.getAddress(),
        operationId: burnId, nonce: 2n, amount: LOCK_AMOUNT, sender: ctx.recipient.address,
        recipient: ctx.user.address, sourceBlockHash: block.hash, expiry: BigInt(block.timestamp + 3600),
      };
      await ctx.wrapper.registerBurnProofWithEvent(burnId, release.nonce, release.sourceBlockHash, release.expiry, burnTxHash, 4);
      const observerBurnTxHash = operationId("observer-burn-event-tx");
      await configureFinality(ctx, 2, 2);
      for (const observer of [ctx.signerA, ctx.signerB]) {
        await ctx.verifier.connect(observer).registerSourceHeader(observer.address, 27, release.sourceBlockHash, ethers.ZeroHash, operationId("slice3-burn-root"));
        await ctx.verifier.connect(observer).registerSourceEvent(observer.address, burnId, 27, release.sourceBlockHash);
        await ctx.verifier.connect(observer).registerSourceEventBinding(
          observer.address, burnId, 27, release.sourceBlockHash, await ctx.wrapper.getAddress(),
          ethers.id("Burned(bytes32,address,address,uint256)"), observerBurnTxHash, 4, LOCK_AMOUNT, ctx.user.address
        );
      }
      await executeGoverned(ctx, "finalizeBurnProof", [burnId]);
      const signatures = await sortedSignatures(ctx.verifier, [ctx.signerA, ctx.signerB], release);
      await expect(ctx.escrow.releaseFromBurn(release, signatures, observerBurnTxHash, 4))
        .to.be.revertedWith("event-binding-mismatch");
    });

    it("invalidates a finalized proof when its source event disappears across a reorg and permits recovery", async function () {
      const ctx = await fixture();
      const oldHash = operationId("slice3-reorg-old");
      const newHash = operationId("slice3-reorg-new");
      const oldRoot = operationId("slice3-reorg-old-root");
      const newRoot = operationId("slice3-reorg-new-root");
      const prepared = await validMint(ctx, { sourceBlockHash: oldHash, expiry: BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600), skipFinalize: true });
      await configureFinality(ctx, 2, 2);
      await observe(ctx, [ctx.signerA, ctx.signerB], 30, oldHash, oldRoot, prepared.fields.operationId);
      await executeGoverned(ctx, "finalizeLockProof", [prepared.fields.operationId]);
      await observe(ctx, [ctx.signerA, ctx.signerB], 31, newHash, newRoot);
      await expect(ctx.verifier.reconcileCanonicalHead(31, newHash, newRoot))
        .to.emit(ctx.verifier, "SourceProofInvalidated").withArgs(prepared.fields.operationId, oldHash);
      const signatures = await sortedSignatures(ctx.verifier, [ctx.signerA, ctx.signerB], prepared.fields);
      await expect(ctx.wrapper.mintFromLock(prepared.fields, signatures, prepared.fields.eventTxHash, prepared.fields.eventLogIndex)).to.be.revertedWith("lock-proof-invalidated");
      await expect(ctx.escrow.refundLock(prepared.fields.operationId, prepared.fields.recipient))
        .to.emit(ctx.escrow, "LockRefunded");
    });

    it("removes a revoked observer's header and event observations from quorum", async function () {
      const ctx = await fixture();
      const hash = operationId("slice3-revoked-head");
      const root = operationId("slice3-revoked-root");
      const prepared = await validMint(ctx, { sourceBlockHash: hash, skipFinalize: true });
      await configureFinality(ctx, 2, 2);
      await observe(ctx, [ctx.signerA, ctx.signerB], 40, hash, root, prepared.fields.operationId);
      await executeGoverned(ctx, "configureObserver", [ctx.signerB.address, false]);
      await expect(executeGoverned(ctx, "finalizeLockProof", [prepared.fields.operationId]))
        .to.be.revertedWith("proposal-call-failed");
    });

    it("restores a re-allowlisted observer's prior observation to quorum", async function () {
      const ctx = await fixture();
      const hash = operationId("slice3-reallowlisted-head");
      const root = operationId("slice3-reallowlisted-root");
      const prepared = await validMint(ctx, { sourceBlockHash: hash, skipFinalize: true });
      await configureFinality(ctx, 2, 2);
      await observe(ctx, [ctx.signerA, ctx.signerB], 41, hash, root, prepared.fields.operationId);
      await executeGoverned(ctx, "configureObserver", [ctx.signerB.address, false]);
      await executeGoverned(ctx, "configureObserver", [ctx.signerB.address, true]);
      await expect(executeGoverned(ctx, "finalizeLockProof", [prepared.fields.operationId])).to.not.be.reverted;
    });

    it("does not count duplicate submissions from one observer twice", async function () {
      const ctx = await fixture();
      const hash = operationId("slice3-duplicate-observer-head");
      const root = operationId("slice3-duplicate-observer-root");
      const prepared = await validMint(ctx, { sourceBlockHash: hash, skipFinalize: true });
      await configureFinality(ctx, 2, 2);
      await observe(ctx, [ctx.signerA], 42, hash, root, prepared.fields.operationId);
      await observe(ctx, [ctx.signerA], 42, hash, root, prepared.fields.operationId);
      await expect(executeGoverned(ctx, "finalizeLockProof", [prepared.fields.operationId]))
        .to.be.revertedWith("proposal-call-failed");
    });

    it("invalidates a finalized proof when revocation drops active event quorum", async function () {
      const ctx = await fixture();
      const oldHash = operationId("slice3-revoked-event-old");
      const newHash = operationId("slice3-revoked-event-new");
      const oldRoot = operationId("slice3-revoked-event-old-root");
      const newRoot = operationId("slice3-revoked-event-new-root");
      const prepared = await validMint(ctx, { sourceBlockHash: oldHash, skipFinalize: true });
      await configureFinality(ctx, 2, 2);
      await observe(ctx, [ctx.signerA, ctx.signerB], 43, oldHash, oldRoot, prepared.fields.operationId);
      await executeGoverned(ctx, "finalizeLockProof", [prepared.fields.operationId]);
      await executeGoverned(ctx, "configureObserver", [ctx.signerB.address, false]);
      await executeGoverned(ctx, "configureObserver", [ctx.observerD.address, true]);
      await observe(ctx, [ctx.signerC, ctx.observerD], 44, newHash, newRoot);
      await expect(ctx.verifier.reconcileCanonicalHead(44, newHash, newRoot))
        .to.emit(ctx.verifier, "SourceProofInvalidated").withArgs(prepared.fields.operationId, oldHash);
    });
  });
});
