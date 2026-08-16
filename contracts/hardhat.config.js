require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      // Tests run on the built-in chain.
    },
    iostL2: {
      // IOST L2 mainnet (EVM-compatible rollup). Official RPC + chain id from
      // https://chainlist.org/chain/182 — do NOT commit real private keys.
      url: process.env.IOST_L2_RPC || "https://l2-mainnet.iost.io",
      chainId: 182,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    // IOST L2 explorer is Blockscout: https://l2-scan.iost.io (verify via its
    // etherscan-compatible /api endpoint or the Blockscout web UI).
    apiKey: process.env.EXPLORER_API_KEY || "",
    customChains: [
      {
        network: "iostL2",
        chainId: 182,
        urls: {
          apiURL: process.env.EXPLORER_API_URL || "https://l2-scan.iost.io/api",
          browserURL: process.env.EXPLORER_URL || "https://l2-scan.iost.io",
        },
      },
    ],
  },
};
