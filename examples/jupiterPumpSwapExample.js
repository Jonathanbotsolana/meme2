/**
 * Example usage of Jupiter PumpSwap API integration
 */
const JupiterApiClient = require('../src/utils/jupiterApiClient');
const { PublicKey } = require('@solana/web3.js');

// Create Jupiter API client
const jupiterClient = new JupiterApiClient({
  tier: 'free', // Use 'free', 'proI', 'proII', 'proIII', or 'proIV'
  apiKey: null, // API key is required for paid tiers
  debug: true // Enable debug logging
});

// Example token address (replace with an actual PumpSwap token)
const PUMPSWAP_TOKEN_ADDRESS = '2q7jMwWYFxUdxBqWbi8ohztyG1agjQMrasUXwqGCpump';

// Example user wallet (replace with your wallet)
const USER_WALLET = '6Cf7nWaodsE6vH4uctqURbEhJReYypifdhhB9Rn7NByU';

// Example function to execute a PumpSwap direct swap
async function executePumpSwapDirectSwap() {
  try {
    console.log(`Executing PumpSwap direct swap for ${PUMPSWAP_TOKEN_ADDRESS}...`);
    
    const result = await jupiterClient.executePumpSwapDirectSwap({
      tokenAddress: PUMPSWAP_TOKEN_ADDRESS,
      userWallet: USER_WALLET,
      solAmount: 0.01, // 0.01 SOL
      priorityFeeLevel: 'medium' // 'low', 'medium', 'high'
    });
    
    console.log('Swap result:', JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error('Error executing PumpSwap direct swap:', error.message);
    return null;
  }
}

// Example function to get PumpSwap transaction instructions
async function getPumpSwapInstructions() {
  try {
    console.log(`Getting PumpSwap instructions for ${PUMPSWAP_TOKEN_ADDRESS}...`);
    
    const instructionsData = await jupiterClient.createPumpSwapTransaction({
      tokenAddress: PUMPSWAP_TOKEN_ADDRESS,
      userWallet: USER_WALLET,
      inputAmount: 10000000, // 0.01 SOL in lamports
      priorityFeeLevel: 'medium' // 'low', 'medium', 'high'
    });
    
    console.log('Instructions data:', JSON.stringify(instructionsData, null, 2));
    return instructionsData;
  } catch (error) {
    console.error('Error getting PumpSwap instructions:', error.message);
    return null;
  }
}

// Example function to try swap with fallback
async function trySwapWithFallback() {
  try {
    console.log(`Trying swap with fallback for ${PUMPSWAP_TOKEN_ADDRESS}...`);
    
    const result = await jupiterClient.swapWithFallback({
      tokenAddress: PUMPSWAP_TOKEN_ADDRESS,
      userWallet: USER_WALLET,
      solAmount: 0.01, // 0.01 SOL
      slippageBps: 500, // 5% slippage
      priorityFeeLevel: 'medium' // 'low', 'medium', 'high'
    });
    
    console.log('Swap with fallback result:', JSON.stringify(result, null, 2));
    console.log(`Used fallback: ${result.usedFallback}`);
    return result;
  } catch (error) {
    console.error('Error trying swap with fallback:', error.message);
    return null;
  }
}

// Main function to run examples
async function runExamples() {
  console.log('Jupiter PumpSwap API Example');
  console.log('============================');
  
  // Get client status
  const status = jupiterClient.getStatus();
  console.log('Client status:', JSON.stringify(status, null, 2));
  
  // Check if token is tradable on Jupiter
  const tradability = await jupiterClient.isTokenTradable(PUMPSWAP_TOKEN_ADDRESS);
  console.log(`Token tradable on Jupiter: ${tradability.tradable}`);
  
  // If not tradable on Jupiter, try PumpSwap
  if (!tradability.tradable) {
    console.log('Token not tradable on Jupiter, trying PumpSwap...');
    
    // Get PumpSwap instructions
    await getPumpSwapInstructions();
    
    // Execute PumpSwap direct swap
    // Note: This will not actually send the transaction in this example
    await executePumpSwapDirectSwap();
    
    // Try swap with fallback
    await trySwapWithFallback();
  } else {
    console.log('Token is tradable on Jupiter, no need for PumpSwap fallback');
  }
  
  console.log('Examples completed!');
}

// Run the examples
runExamples().catch(error => {
  console.error('Error running examples:', error);
});