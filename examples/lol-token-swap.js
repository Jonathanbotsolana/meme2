/**
 * Example script for executing a LOL token swap
 * This demonstrates how to use the specialized LOL token swap functionality
 * 
 * NOTE: This is a simulated swap for demonstration purposes.
 * To implement a real swap, you would need to integrate with the Raydium SDK
 * and implement the actual swap logic in the raydiumDirectClient.js file.
 */

require('dotenv').config();
const logger = require('../src/utils/logger');
const swapExecutor = require('../src/modules/swapExecutor');
const wallet = require('../src/utils/wallet');
const config = require('../config/config');

// Set TRADING_ENABLED=true in .env to execute real trades
process.env.TRADING_ENABLED = process.env.TRADING_ENABLED || 'false';
config.trading = config.trading || {};
config.trading.enabled = process.env.TRADING_ENABLED === 'true';

// Debug log to verify environment variable value
logger.info(`TRADING_ENABLED environment variable value: '${process.env.TRADING_ENABLED}'`);
logger.info(`config.trading.enabled value: ${config.trading.enabled}`);

async function executeLolTokenSwap() {
  try {
    logger.info('Starting LOL token swap example');
    
    // Check wallet balance
    const walletBalance = await swapExecutor.getWalletBalance();
    logger.info(`Wallet balance: ${walletBalance} SOL`);
    
    if (walletBalance < 0.01) {
      logger.error('Insufficient balance. Need at least 0.01 SOL to execute swap.');
      return;
    }
    
    // Amount to swap (in SOL)
    const amountToSwap = 0.01; // 0.01 SOL
    
    // Slippage percentage
    const slippage = 1.0; // 1% slippage
    
    logger.info(`Executing LOL token swap with ${amountToSwap} SOL (${slippage}% slippage)`);
    logger.info(`Trading enabled: ${process.env.TRADING_ENABLED === 'true' ? 'Yes' : 'No (Simulation only)'}`);
    
    // Execute the swap
    logger.info(`Note: This is a simulated swap for demonstration purposes. No actual swap will be executed.`);
    const result = await swapExecutor.executeLolTokenSwap(amountToSwap, slippage);
    
    if (result.success) {
      logger.info('Swap executed successfully!');
      logger.info(`Transaction hash: ${result.txHash}`);
      logger.info(`Input: ${result.inputAmount} SOL`);
      logger.info(`Output: ${result.outputAmount} LOL tokens`);
      logger.info(`Provider: ${result.provider}`);
    } else {
      logger.error(`Swap failed: ${result.error}`);
    }
  } catch (error) {
    logger.error(`Error executing LOL token swap: ${error.message}`);
  }
}

// Execute the swap
executeLolTokenSwap().then(() => {
  logger.info('LOL token swap example completed');
  process.exit(0);
}).catch(error => {
  logger.error(`Unhandled error: ${error.message}`);
  process.exit(1);
});