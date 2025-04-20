/**
 * Example usage of Jupiter API Client
 */
const JupiterApiClient = require('../src/utils/jupiterApiClient');
const { PublicKey } = require('@solana/web3.js');

// Create Jupiter API client
const jupiterClient = new JupiterApiClient({
  tier: 'free', // Use 'free', 'proI', 'proII', 'proIII', or 'proIV'
  apiKey: null, // API key is required for paid tiers
  debug: true // Enable debug logging
});

// Example token addresses
const SOL_ADDRESS = 'So11111111111111111111111111111111111111112';
const USDC_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK_ADDRESS = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

// Example function to get token prices
async function getTokenPrices() {
  try {
    console.log('Getting token prices...');
    const prices = await jupiterClient.getTokenPrices([SOL_ADDRESS, USDC_ADDRESS, BONK_ADDRESS]);
    console.log('Token prices:', JSON.stringify(prices, null, 2));
    return prices;
  } catch (error) {
    console.error('Error getting token prices:', error.message);
    return null;
  }
}

// Example function to get token info
async function getTokenInfo(tokenAddress) {
  try {
    console.log(`Getting token info for ${tokenAddress}...`);
    const tokenInfo = await jupiterClient.getTokenInfo(tokenAddress);
    console.log('Token info:', JSON.stringify(tokenInfo, null, 2));
    return tokenInfo;
  } catch (error) {
    console.error('Error getting token info:', error.message);
    return null;
  }
}

// Example function to get a quote
async function getQuote(inputMint, outputMint, amount) {
  try {
    console.log(`Getting quote for ${amount} ${inputMint} to ${outputMint}...`);
    const quote = await jupiterClient.getQuote({
      inputMint,
      outputMint,
      amount,
      slippageBps: 50 // 0.5% slippage
    });
    console.log('Quote:', JSON.stringify(quote, null, 2));
    return quote;
  } catch (error) {
    console.error('Error getting quote:', error.message);
    return null;
  }
}

// Example function to check if a token is tradable
async function checkTokenTradability(tokenAddress) {
  try {
    console.log(`Checking tradability for ${tokenAddress}...`);
    const result = await jupiterClient.isTokenTradable(tokenAddress);
    console.log('Tradability result:', JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error('Error checking token tradability:', error.message);
    return null;
  }
}

// Main function to run examples
async function runExamples() {
  console.log('Jupiter API Client Example');
  console.log('=========================');
  
  // Get client status
  const status = jupiterClient.getStatus();
  console.log('Client status:', JSON.stringify(status, null, 2));
  
  // Run examples
  await getTokenPrices();
  await getTokenInfo(SOL_ADDRESS);
  
  // Get quote for 0.1 SOL to USDC
  // SOL has 9 decimals, so 0.1 SOL = 10^8 lamports
  await getQuote(SOL_ADDRESS, USDC_ADDRESS, 100000000);
  
  // Check if BONK is tradable
  await checkTokenTradability(BONK_ADDRESS);
  
  console.log('Examples completed!');
}

// Run the examples
runExamples().catch(error => {
  console.error('Error running examples:', error);
});