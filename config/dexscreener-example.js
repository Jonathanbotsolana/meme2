/**
 * Example configuration for DexScreener integration
 * 
 * This file shows how to configure the DexScreener integration in the config.js file
 */

module.exports = {
  // Other configuration options...
  
  trading: {
    // Existing trading configuration
    maxTradeSizeSol: 0.1,
    defaultSlippage: 2.5,
    
    // DexScreener configuration
    dexScreener: {
      enabled: true, // Set to false to disable DexScreener checks
      minLiquidityUsd: 5000, // Minimum liquidity in USD required for a pair to be considered active
      minVolumeUsd: 1000, // Minimum 24h volume in USD required for a pair to be considered active
      requireVerifiedPair: false, // Set to true to require at least one verified pair
      requireJupiterCompatiblePair: true, // Set to true to require at least one Jupiter-compatible pair
      preferredDexes: [
        'raydium', // Raydium DEX
        'orca',    // Orca DEX
        'meteora', // Meteora DEX
        'jupiter', // Jupiter Swap
        'pumpswap', // PumpSwap
        'phoenix',  // Phoenix
        'dooar'     // Dooar
      ]
    },
    
    // Other trading configuration options...
  },
  
  // Other configuration options...
};