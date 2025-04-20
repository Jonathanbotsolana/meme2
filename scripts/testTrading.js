/**
 * Test Trading Script
 * 
 * This script allows you to test the trading functionality with the enhanced monitoring
 * in a safe environment before enabling real trading.
 */

// Load environment variables from .env file
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const logger = require('../src/utils/logger');
const riskFilter = require('../src/modules/riskFilter');
const tradingMonitor = require('../src/utils/tradingMonitor');

// Check if .env file exists
const envPath = path.resolve(process.cwd(), '.env');
if (!fs.existsSync(envPath)) {
  console.error('Error: .env file not found. Please create one based on .env.example');
  process.exit(1);
}

// Force set environment variables if not present in .env
if (!process.env.TRADING_ENABLED) {
  process.env.TRADING_ENABLED = 'true';
  console.log('Forcing TRADING_ENABLED=true for testing');
}

if (!process.env.TEST_MODE) {
  process.env.TEST_MODE = 'true';
  console.log('Forcing TEST_MODE=true for testing');
}

// Sample tokens to test (including the whitelisted ones)
const testTokens = [
  'ER7qoXEsKfmmLehwmZaK1WVoDTxSBWsnqEKgcVYFpump', // ◎ token (whitelisted)
  'fESbUKjuMY6jzDH9VP8cy4p3pu2q5W2rK2XghVfNseP', // SOLANA token (whitelisted)
  'So11111111111111111111111111111111111111112', // Wrapped SOL (whitelisted)
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (whitelisted)
  // Add some non-whitelisted tokens to test the risk filter
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', // SAMO
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
];

// Simulate a trade for a token
async function simulateTrade(tokenAddress) {
  logger.info(`Simulating trade for token: ${tokenAddress}`);
  
  try {
    // Check if token is safe
    const safetyCheck = await riskFilter.isTokenSafe(tokenAddress);
    
    if (!safetyCheck.isSafe) {
      logger.warn(`Token ${tokenAddress} failed safety check: ${safetyCheck.reasons.join(', ')}`);
      return false;
    }
    
    // Simulate a successful trade 80% of the time for non-whitelisted tokens
    // Always succeed for whitelisted tokens
    const isWhitelisted = riskFilter.whitelistedTokens.has(tokenAddress);
    const tradeSuccess = isWhitelisted || Math.random() > 0.2;
    
    if (tradeSuccess) {
      // Simulate some profit/loss (-0.1 to +0.2 SOL)
      const profitLoss = (Math.random() * 0.3 - 0.1).toFixed(4);
      tradingMonitor.recordSuccessfulTrade(tokenAddress, parseFloat(profitLoss));
      logger.info(`Trade successful for ${tokenAddress} with P/L: ${profitLoss} SOL`);
      return true;
    } else {
      // Simulate a trade failure
      const reasons = [
        'Insufficient liquidity',
        'Slippage too high',
        'Transaction failed',
        'Price impact too high'
      ];
      const randomReason = reasons[Math.floor(Math.random() * reasons.length)];
      tradingMonitor.recordFailedTrade(tokenAddress, randomReason);
      logger.error(`Trade failed for ${tokenAddress}: ${randomReason}`);
      return false;
    }
  } catch (error) {
    logger.error(`Error simulating trade: ${error.message}`);
    return false;
  }
}

// Main function to run the test
async function runTest() {
  logger.info('Starting trading test with monitoring');
  
  // Debug environment variables
  logger.info(`Environment variables loaded: TRADING_ENABLED=${process.env.TRADING_ENABLED}, TEST_MODE=${process.env.TEST_MODE}`);
  
  // Check if trading is enabled
  if (process.env.TRADING_ENABLED !== 'true') {
    logger.warn('Trading is not enabled. Forcing TRADING_ENABLED=true for this test');
    process.env.TRADING_ENABLED = 'true';
  }
  
  // Check if we're in test mode
  if (process.env.TEST_MODE !== 'true') {
    logger.warn('Test mode is not enabled. Forcing TEST_MODE=true for this test');
    process.env.TEST_MODE = 'true';
  }
  
  // Start the trading monitor
  tradingMonitor.startMonitoring(5); // Generate reports every 5 minutes during testing
  
  // Test each token
  for (const token of testTokens) {
    await simulateTrade(token);
    // Add a small delay between trades
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Generate a final report
  tradingMonitor.generateReport();
  
  logger.info('Trading test completed');
}

// Run the test
runTest().catch(error => {
  logger.error(`Test failed: ${error.message}`);
  process.exit(1);
});