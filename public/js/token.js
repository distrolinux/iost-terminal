// Public AITT wallet-readiness preview. No signing, claim, swap, or deployment action exists here.
const CHAIN_ID = 182;
const CHAIN_HEX = '0xb6';
const RPC_URL = 'https://l2-mainnet.iost.io';
const EXPLORER_URL = 'https://l2-scan.iost.io';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const walletState = { account: '', chainId: null, deployed: false };

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

function chainNumber(chainHex) {
  const chainId = Number.parseInt(String(chainHex || ''), 16);
  return Number.isSafeInteger(chainId) ? chainId : null;
}

function renderWalletState(message = '') {
  const connected = Boolean(walletState.account);
  const supported = walletState.chainId === CHAIN_ID;
  const networkText = message || (connected
    ? (supported ? 'IOST L2 · chain 182' : `unsupported network · chain ${walletState.chainId ?? 'unknown'}`)
    : 'wallet disconnected · chain 182 required');
  setText('walletAddress', connected ? shortAddress(walletState.account) : 'not connected');
  setText('walletNetwork', networkText);
  const switchButton = byId('switchNetworkBtn');
  if (switchButton) switchButton.disabled = !window.ethereum || supported;
  const addButton = byId('addTokenBtn');
  if (addButton) addButton.disabled = !walletState.deployed || !window.ethereum || !connected || !supported;
}

function updateWalletState(accounts, chainHex) {
  walletState.account = ADDRESS_RE.test(String(accounts?.[0] || '')) ? accounts[0] : '';
  walletState.chainId = chainNumber(chainHex);
  renderWalletState();
}

async function syncWalletState() {
  if (!window.ethereum) {
    walletState.account = '';
    walletState.chainId = null;
    renderWalletState('EVM wallet unavailable');
    return;
  }
  const [accounts, chainHex] = await Promise.all([
    window.ethereum.request({ method: 'eth_accounts' }),
    window.ethereum.request({ method: 'eth_chainId' }),
  ]);
  updateWalletState(accounts, chainHex);
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
  const chainHex = await window.ethereum.request({ method: 'eth_chainId' });
  updateWalletState(accounts, chainHex);
  if (!walletState.account) throw new Error('No wallet account selected');
}

function resetWalletState(message = 'wallet disconnected · chain 182 required') {
  walletState.account = '';
  walletState.chainId = null;
  renderWalletState(message);
}

function bindWalletEvents() {
  if (!window.ethereum?.on) return;
  window.ethereum.on('accountsChanged', (accounts) => {
    const chainHex = walletState.chainId == null ? '' : `0x${walletState.chainId.toString(16)}`;
    updateWalletState(accounts, chainHex);
  });
  window.ethereum.on('chainChanged', (chainHex) => {
    walletState.chainId = chainNumber(chainHex);
    renderWalletState();
  });
  window.ethereum.on('disconnect', () => resetWalletState());
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

  walletState.deployed = deployed;
  setText('tokenDeployStatus', deployed ? 'deployed · verify on explorer' : 'pre-launch · no token issued');
  setText('tokenContractValue', deployed ? shortAddress(info.contractAddress) : 'pending deployment');
  setText('tradeStatus', trade.statusText || 'disabled — Phase 4 liquidity is not live');
  setText('tradeNetwork', `${trade.dex || 'PancakeSwap'} · ${trade.chain || 'BNB Smart Chain'} (chain ${trade.chainId || 56})`);

  const explorer = byId('tokenExplorerBtn');
  explorer.href = deployed ? `${info.explorerUrl}/address/${info.contractAddress}` : info.explorerUrl;
  explorer.textContent = deployed ? 'View token contract' : 'Open IOST L2 explorer';

  const add = byId('addTokenBtn');
  add.dataset.address = deployed ? info.contractAddress : '';
  renderWalletState();

  const swap = byId('swapAittBtn');
  if (swapUrl) {
    swap.href = swapUrl;
    swap.removeAttribute('aria-disabled');
    swap.classList.remove('disabled');
    swap.textContent = 'Open verified PancakeSwap route';
  }
}

byId('connectWalletBtn')?.addEventListener('click', async () => {
  try { await connectWallet(); } catch (error) { renderWalletState(error.message); }
});
byId('switchNetworkBtn')?.addEventListener('click', async () => {
  try { await switchToIostL2(); await syncWalletState(); } catch (error) { renderWalletState(error.message); }
});
byId('addTokenBtn')?.addEventListener('click', async (event) => {
  const address = event.currentTarget.dataset.address;
  if (!window.ethereum || !walletState.account || walletState.chainId !== CHAIN_ID || !ADDRESS_RE.test(address)) return;
  try {
    await switchToIostL2();
    await window.ethereum.request({ method: 'wallet_watchAsset', params: { type: 'ERC20', options: { address, symbol: 'AITT', decimals: 8, image: 'https://iostcallister.com/img/aitt-hex.png' } } });
  } catch (error) { renderWalletState(error.message); }
});

bindWalletEvents();
syncWalletState().catch(() => resetWalletState('wallet state unavailable'));
loadDashboard().catch((error) => {
  setText('tokenDeployStatus', error.message);
  setText('tradeStatus', 'disabled — status could not be verified');
  walletState.deployed = false;
  renderWalletState();
});
