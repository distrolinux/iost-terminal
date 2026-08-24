// On-chain receipt and release-gate verification for AITT conversion.
import { Contract, Interface, JsonRpcProvider, getAddress } from 'ethers';

const EVENTS = new Interface(['event Approved(address indexed user,uint256 amount)', 'event Converted(address indexed user,uint256 amount)']);
const ACCOUNT_ABI = ['function approved(address) view returns(uint256)', 'function claimed(address) view returns(uint256)'];
const TOKEN_ABI = ['function totalSupply() view returns(uint256)', 'function SUPPLY_FLOOR() view returns(uint256)', 'function feeRouter() view returns(address)', 'function ammPair() view returns(address)', 'function balanceOf(address) view returns(uint256)'];
const CONVERTER_ABI = ['function token() view returns(address)', 'function reserve() view returns(uint256)', 'function totalOutstanding() view returns(uint256)'];
const ALLOCATION_ABI = ['function totalAllocated() view returns(uint256)', 'function released() view returns(uint256)'];
const PAIR_ABI = ['function token0() view returns(address)', 'function token1() view returns(address)'];
const FACTORY_ABI = ['function getPair(address,address) view returns(address)'];

export function verifyReleaseAccounting({ configuredReserve, reserve, outstanding, reserved, converterBalance, allocations }) {
  if (reserve > configuredReserve || converterBalance !== reserve || reserve < outstanding + reserved) return false;
  return allocations.every(({ expected, totalAllocated, released, balance }) =>
    totalAllocated === expected && released <= expected && balance + released === expected);
}

export async function probeTradingState(trading, rpcUrl = 'https://bsc-dataseed.binance.org') {
  try {
    const provider = new JsonRpcProvider(rpcUrl, 56, { staticNetwork: true });
    if ((await provider.getNetwork()).chainId !== 56n) return { verified: false, error: 'wrong trading chain' };
    const token = getAddress(trading.tokenAddress);
    const pairAddress = getAddress(trading.pairAddress);
    const factoryAddress = getAddress(trading.factoryAddress);
    const quote = getAddress(trading.quoteToken);
    for (const address of [token, pairAddress, factoryAddress, quote]) {
      if (await provider.getCode(address) === '0x') return { verified: false, error: `missing trading bytecode: ${address}` };
    }
    const pair = new Contract(pairAddress, PAIR_ABI, provider);
    const factory = new Contract(factoryAddress, FACTORY_ABI, provider);
    const [token0, token1, factoryPair] = await Promise.all([pair.token0(), pair.token1(), factory.getPair(token, quote)]);
    const assets = new Set([getAddress(token0), getAddress(token1)]);
    const verified = assets.has(token) && assets.has(quote) && getAddress(factoryPair) === pairAddress;
    return { verified, token, pairAddress, factoryAddress, quoteToken: quote };
  } catch (error) { return { verified: false, error: error.message }; }
}

function verifyEvent({ receipt, converterAddress, eventName, user, amount }) {
  let converter, expectedUser;
  try { converter = getAddress(converterAddress); expectedUser = getAddress(user); }
  catch { return { ok: false, error: 'invalid converter or user address' }; }
  if (!receipt || Number(receipt.status) !== 1) return { ok: false, error: 'transaction not successful' };
  try { if (getAddress(receipt.to) !== converter) return { ok: false, error: 'transaction target is not converter' }; }
  catch { return { ok: false, error: 'invalid receipt target' }; }
  for (const log of receipt.logs || []) {
    try {
      if (getAddress(log.address) !== converter) continue;
      const parsed = EVENTS.parseLog(log);
      if (parsed?.name === eventName && getAddress(parsed.args.user) === expectedUser && BigInt(parsed.args.amount) === BigInt(amount)) return { ok: true, blockNumber: Number(receipt.blockNumber) };
    } catch { /* unrelated log */ }
  }
  return { ok: false, error: `${eventName} event mismatch` };
}

export function verifyApprovalReceipt(args) { return verifyEvent({ ...args, eventName: 'Approved' }); }
export function verifyConversionReceipt(args) { return verifyEvent({ ...args, eventName: 'Converted' }); }

export async function fetchReceipt(txHash, rpcUrl = 'https://l2-mainnet.iost.io', minConfirmations = 12) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) throw new Error('valid tx hash required');
  const provider = new JsonRpcProvider(rpcUrl, 182, { staticNetwork: true });
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error('transaction receipt not found');
  const confirmations = (await provider.getBlockNumber()) - receipt.blockNumber + 1;
  if (confirmations < minConfirmations) throw new Error(`transaction needs ${minConfirmations} confirmations; has ${confirmations}`);
  return receipt;
}

export async function fetchConverterAccountState(converterAddress, user, rpcUrl = 'https://l2-mainnet.iost.io') {
  const converter = new Contract(getAddress(converterAddress), ACCOUNT_ABI, new JsonRpcProvider(rpcUrl, 182, { staticNetwork: true }));
  return { approved: await converter.approved(user), claimed: await converter.claimed(user) };
}

export async function probeReleaseState(config, reservedBaseUnits = 0n, rpcUrl = 'https://l2-mainnet.iost.io') {
  const provider = new JsonRpcProvider(rpcUrl, 182, { staticNetwork: true });
  if ((await provider.getNetwork()).chainId !== 182n) return { verified: false, error: 'wrong chain' };
  const addresses = [config.contractAddress, config.feeRouterAddress, config.converterAddress, ...Object.values(config.vaultAddresses || {})];
  for (const address of addresses) if (!address || await provider.getCode(address) === '0x') return { verified: false, error: `missing bytecode: ${address || 'unset'}` };
  const token = new Contract(config.contractAddress, TOKEN_ABI, provider);
  const converter = new Contract(config.converterAddress, CONVERTER_ABI, provider);
  const [supply, floor, router, pair, converterToken, reserve, outstanding] = await Promise.all([token.totalSupply(), token.SUPPLY_FLOOR(), token.feeRouter(), token.ammPair(), converter.token(), converter.reserve(), converter.totalOutstanding()]);
  const unit = 10n ** 8n;
  const configuredReserve = BigInt(config.reserveAITT || 0) * unit;
  const expected = { ecosystemEmission: 300_000_000n * unit - configuredReserve, treasury: 200_000_000n * unit, team: 150_000_000n * unit, partners: 100_000_000n * unit, community: 100_000_000n * unit, reserve: 100_000_000n * unit, advisor: 50_000_000n * unit };
  const allocations = [];
  for (const [key, amount] of Object.entries(expected)) {
    const address = config.vaultAddresses[key];
    const vault = new Contract(address, ALLOCATION_ABI, provider);
    const [totalAllocated, released, balance] = await Promise.all([
      vault.totalAllocated(), vault.released(), token.balanceOf(address),
    ]);
    allocations.push({ expected: amount, totalAllocated, released, balance });
  }
  const converterBalance = await token.balanceOf(config.converterAddress);
  const allocationsVerified = verifyReleaseAccounting({
    configuredReserve, reserve, outstanding, reserved: BigInt(reservedBaseUnits), converterBalance, allocations,
  });
  const verified = floor === 800_000_000n * unit && supply >= floor && supply <= 1_000_000_000n * unit
    && getAddress(router) === getAddress(config.feeRouterAddress) && /^0x0{40}$/i.test(pair)
    && getAddress(converterToken) === getAddress(config.contractAddress)
    && allocationsVerified;
  return { verified, supply: supply.toString(), reserve: reserve.toString(), outstanding: outstanding.toString(), allocationsVerified };
}
