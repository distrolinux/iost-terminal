// Public AITT access dashboard. No transaction or deployment action exists here.
const CHAIN_ID = 182;
const CHAIN_HEX = '0xb6';
const RPC_URL = 'https://l2-mainnet.iost.io';
const EXPLORER_URL = 'https://l2-scan.iost.io';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const byId = (id) => document.getElementById(id);
const shortAddress = (value) => `${value.slice(0, 8)}…${value.slice(-6)}`;

function setText(id, value) {
  const el = byId(id);
  if (el) el.textContent = value;
}

function approvedSwapUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'pancakeswap.finance' || url.hostname.endsWith('.pancakeswap.finance')) ? url.href : '';
  } catch { return ''; }
}

async function switchToIostL2() {
  if (!window.ethereum) throw new Error('MetaMask or another EVM wallet is required');
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] });
  } catch (error) {
    if (Number(error?.code) !== 4902) throw error;
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: CHAIN_HEX,
        chainName: 'IOST L2',
        nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
        rpcUrls: [RPC_URL],
        blockExplorerUrls: [EXPLORER_URL],
      }],
    });
  }
}

async function connectWallet() {
  if (!window.ethereum) throw new Error('MetaMask or another EVM wallet is required');
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (!accounts?.[0]) throw new Error('No wallet account selected');
  const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
  setText('walletAddress', shortAddress(accounts[0]));
  setText('walletNetwork', Number.parseInt(chainHex, 16) === CHAIN_ID ? 'IOST L2 · chain 182' : `wrong network · chain ${Number.parseInt(chainHex, 16)}`);
  byId('switchNetworkBtn').disabled = Number.parseInt(chainHex, 16) === CHAIN_ID;
}

async function loadDashboard() {
  const response = await fetch('/api/aitt/info', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('AITT status API unavailable');
  const info = await response.json();
  const deployed = info.status === 'deployed'
    && info.conversion?.releaseGate?.live?.verified === true
    && ADDRESS_RE.test(String(info.contractAddress || ''));
  const trade = info.trading || {};
  const swapUrl = trade.ready ? approvedSwapUrl(trade.swapUrl) : '';

  setText('tokenDeployStatus', deployed ? 'deployed · verify on explorer' : 'pre-launch · no token issued');
  setText('tokenContractValue', deployed ? shortAddress(info.contractAddress) : 'pending deployment');
  setText('tradeStatus', trade.statusText || 'disabled — Phase 4 liquidity is not live');
  setText('tradeNetwork', `${trade.dex || 'PancakeSwap'} · ${trade.chain || 'BNB Smart Chain'} (chain ${trade.chainId || 56})`);

  const explorer = byId('tokenExplorerBtn');
  explorer.href = deployed ? `${info.explorerUrl}/address/${info.contractAddress}` : info.explorerUrl;
  explorer.textContent = deployed ? 'View token contract' : 'Open IOST L2 explorer';

  const add = byId('addTokenBtn');
  add.disabled = !deployed || !window.ethereum;
  add.dataset.address = deployed ? info.contractAddress : '';

  const swap = byId('swapAittBtn');
  if (swapUrl) {
    swap.href = swapUrl;
    swap.removeAttribute('aria-disabled');
    swap.classList.remove('disabled');
    swap.textContent = 'Open verified PancakeSwap route';
  }
}

byId('connectWalletBtn')?.addEventListener('click', async () => {
  try { await connectWallet(); } catch (error) { setText('walletNetwork', error.message); }
});
byId('switchNetworkBtn')?.addEventListener('click', async () => {
  try { await switchToIostL2(); await connectWallet(); } catch (error) { setText('walletNetwork', error.message); }
});
byId('addTokenBtn')?.addEventListener('click', async (event) => {
  const address = event.currentTarget.dataset.address;
  if (!window.ethereum || !ADDRESS_RE.test(address)) return;
  try {
    await switchToIostL2();
    await window.ethereum.request({ method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address, symbol: 'AITT', decimals: 8, image: 'https://iostcallister.com/img/aitt-hex.png' } } });
  } catch (error) { setText('walletNetwork', error.message); }
});

loadDashboard().catch((error) => {
  setText('tokenDeployStatus', error.message);
  setText('tradeStatus', 'disabled — status could not be verified');
});
