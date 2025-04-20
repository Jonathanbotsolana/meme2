/**
 * Example of using the updated Jupiter SDK swap functionality
 */

// Load environment variables
require('dotenv').config();

// Import dependencies
const { ApeJupiterClient } = require('../src/utils/apeJupiterClient');
const logger = require('../src/utils/logger');

// Example token addresses (replace with actual tokens you want to swap)
const BONK_TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK
const WIF_TOKEN = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'; // WIF

// Initialize the Jupiter client with options
const jupiterClient = new ApeJupiterClient({
  apiKey: process.env.JUPITER_API_KEY, // Your Jupiter API key if you have one
  defaultSlippage: 0.05, // 5% default slippage
  useRaydiumFallback: true, // Enable Raydium fallback
  usePumpSwapFallback: true, // Enable PumpSwap fallback
});

/**
 * Execute a swap using the Jupiter SDK
 */
async function executeJupiterSwap() {
  try {
    // Amount of SOL to swap
    const amountInSol = 0.01; // 0.01 SOL
    
    // Slippage tolerance (5%)
    const slippage = 0.05;
    
    logger.info(`Starting swap of ${amountInSol} SOL for BONK tokens...`);
    
    // Execute the swap using the new executeSwap method
    const result = await jupiterClient.executeSwap(
      BONK_TOKEN,
      amountInSol,
      slippage,
      { useFallbacks: true }
    );
    
    logger.info('Swap completed successfully!');
    logger.info(`Transaction hash: ${result.txHash}`);
    logger.info(`Received ${result.outputAmount} BONK tokens`);
    logger.info(`Approximate USD value: ${result.outputAmountUsd}`);
    
    return result;
  } catch (error) {
    logger.error(`Swap failed: ${error.message}`);
    throw error;
  }
}

// Run the example if this file is executed directly
if (require.main === module) {
  executeJupiterSwap()
    .then(result => {
      console.log('Swap completed successfully!');
      console.log(result);
      process.exit(0);
    })
    .catch(error => {
      console.error('Swap failed:', error);
      process.exit(1);
    });
}

module.exports = { executeJupiterSwap };