require('dotenv').config();
const cron = require('node-cron');
const config = require('../config/config');
const logger = require('./utils/logger');
const database = require('./utils/database');
const wallet = require('./utils/wallet');
const rpcHealthMonitor = require('./utils/rpcHealthMonitor');
const rpcManager = require('./utils/rpcManager');

// Import modules
const marketScanner = require('./modules/marketScanner');
const sentimentDetector = require('./modules/sentimentDetector');
const onChainAnalyzer = require('./modules/onChainAnalyzer');
const swapExecutor = require('./modules/swapExecutor');
const riskFilter = require('./modules/riskFilter');
const pnlTracker = require('./modules/pnlTracker');
const tokenScorer = require('./modules/tokenScorer');
const dashboard = require('./modules/dashboard');
const reinforcementLearning = require('./modules/reinforcementLearning');

class KairosMemeBot {
  constructor() {
    this.isRunning = false;
    this.scanInterval = config.scanner.scanInterval;
    this.maxTradeSizeSol = config.trading.maxTradeSizeSol;
    this.activeTransactions = 0;
    this.maxConcurrentTransactions = parseInt(process.env.MAX_CONCURRENT_TRANSACTIONS || '2');
  }

  async initialize() {
    try {
      logger.info('Initializing Kairos Meme Bot...');
      
      // Initialize RPC health monitor first
      rpcHealthMonitor.start();
      logger.info('RPC health monitor started');
      
      // Log the current RPC endpoint
      const currentEndpoint = rpcManager.getCurrentEndpoint();
      logger.info(`Using RPC endpoint: ${currentEndpoint}`);
      
      // Check wallet initialization
      const walletPublicKey = wallet.getPublicKey();
      logger.info(`Wallet public key: ${walletPublicKey}`);
      
      // Check wallet balance
      const walletBalance = await swapExecutor.getWalletBalance();
      logger.info(`Wallet balance: ${walletBalance} SOL`);
      if (walletBalance < 0.1) {
        logger.warn(`Low wallet balance: ${walletBalance} SOL. Consider adding more funds.`);
      }
      
      // Initialize remaining components
      await pnlTracker.initialize();
      await dashboard.initialize();
      await reinforcementLearning.initialize();
      
      // Do an initial RPC health check
      await rpcHealthMonitor.checkHealth();
      
      // Set up scheduled tasks
      this.setupScheduledTasks();
      
      logger.info('Kairos Meme Bot initialized successfully');
      return true;
    } catch (error) {
      logger.error(`Initialization error: ${error.message}`);
      return false;
    }
  }

  setupScheduledTasks() {
    // Main market scanning task (every minute)
    cron.schedule('* * * * *', async () => {
      await this.scanMarket();
    });
    
    // Check take profit / stop loss (every 30 seconds)
    cron.schedule('*/30 * * * * *', async () => {
      await this.checkTakeProfitStopLoss();
    });
    
    // Update prices for active trades (every 15 seconds)
    cron.schedule('*/15 * * * * *', async () => {
      await this.updateActiveTradePrices();
    });
    
    // Run RPC health check (every 3 minutes)
    cron.schedule('*/3 * * * *', async () => {
      await rpcHealthMonitor.checkHealth();
    });
    
    // Rotate RPC endpoint (every 2 minutes)
    cron.schedule('*/2 * * * *', async () => {
      const oldEndpoint = rpcManager.getCurrentEndpoint();
      const newEndpoint = rpcManager.rotateEndpoint();
      logger.info(`Rotated RPC endpoint from ${oldEndpoint} to ${rpcManager.getCurrentEndpoint()}`);
    });
    
    // Update trading stats (every 5 minutes)
    cron.schedule('*/5 * * * *', async () => {
      await pnlTracker.updateTradingStats();
    });
    
    // Reset active transactions counter if needed (every 10 minutes)
    cron.schedule('*/10 * * * *', async () => {
      await this.resetActiveTransactionsIfNeeded();
    });
    
    logger.info('Scheduled tasks set up');
  }

  async scanMarket() {
    if (this.isRunning) {
      logger.debug('Market scan already in progress, skipping');
      return;
    }
    
    this.isRunning = true;
    logger.info('Starting market scan...');
    
    try {
      // Scan market for new pairs and opportunities
      const scanResults = await marketScanner.scan();
      
      // Check if scanResults is an array (as returned by marketScanner.scan())
      if (Array.isArray(scanResults)) {
        // Process the array of pairs directly
        if (scanResults.length > 0) {
          logger.info(`Processing ${scanResults.length} newly detected pairs`);
          await this.processNewPairs(scanResults);
        } else {
          logger.info('No new pairs found in market scan');
        }
      } else if (scanResults && typeof scanResults === 'object') {
        // Handle the case where scanResults is an object with categorized results
        // Process newly detected pairs
        if (scanResults.newlyDetectedPairs && scanResults.newlyDetectedPairs.length > 0) {
          logger.info(`Processing ${scanResults.newlyDetectedPairs.length} newly detected pairs`);
          await this.processNewPairs(scanResults.newlyDetectedPairs);
        }
        
        // Process top gainers
        const topGainers = [];
        if (scanResults.topGainers1h && Array.isArray(scanResults.topGainers1h)) {
          topGainers.push(...scanResults.topGainers1h);
        }
        if (scanResults.topGainers24h && Array.isArray(scanResults.topGainers24h)) {
          topGainers.push(...scanResults.topGainers24h);
        }
        
        if (topGainers.length > 0) {
          logger.info(`Processing ${topGainers.length} top gainers`);
          await this.processTopGainers(topGainers);
        }
        
        // Process volume spikes
        if (scanResults.volumeSpikes && scanResults.volumeSpikes.length > 0) {
          logger.info(`Processing ${scanResults.volumeSpikes.length} volume spikes`);
          await this.processVolumeSpikes(scanResults.volumeSpikes);
        }
      } else {
        logger.info('Market scan completed with no results');
      }
    } catch (error) {
      logger.error(`Error during market scan: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  async processNewPairs(newPairs) {
    try {
      // Ensure newPairs is an array
      if (!Array.isArray(newPairs)) {
        logger.warn('processNewPairs received non-array input');
        return;
      }
      
      // Check if array is empty
      if (newPairs.length === 0) {
        logger.debug('No new pairs to process');
        return;
      }
      
      // Score new pairs
      const scoredPairs = await tokenScorer.scoreBatch(newPairs);
      
      // Filter by minimum score
      const goodPairs = scoredPairs.filter(pair => pair.score >= tokenScorer.minScore);
      const rejectedPairs = scoredPairs.filter(pair => pair.score < tokenScorer.minScore);
      
      // Track rejected pairs for reinforcement learning
      for (const pair of rejectedPairs) {
        const detailedScores = await tokenScorer.getDetailedScores(pair.token.baseToken.address);
        await reinforcementLearning.trackRejectedToken(
          pair.token, 
          `Score too low: ${pair.score.toFixed(2)} < ${tokenScorer.minScore.toFixed(2)}`, 
          detailedScores
        );
      }
      
      if (goodPairs.length === 0) {
        logger.info('No new pairs met the minimum score threshold');
        return;
      }
      
      logger.info(`Found ${goodPairs.length} promising new pairs`);
      
      // Process each promising pair
      for (const pair of goodPairs) {
        await this.evaluateAndTrade(pair.token);
      }
    } catch (error) {
      logger.error(`Error processing new pairs: ${error.message}`);
    }
  }

  async processTopGainers(topGainers) {
    try {
      // Ensure topGainers is an array
      if (!Array.isArray(topGainers)) {
        logger.warn('processTopGainers received non-array input');
        return;
      }
      
      // Check if array is empty
      if (topGainers.length === 0) {
        logger.debug('No top gainers to process');
        return;
      }
      
      // Get top scoring tokens
      const topScoringTokens = await tokenScorer.getTopScoringTokens(topGainers, 0.8, 3);
      
      if (topScoringTokens.length === 0) {
        logger.info('No top gainers met the score threshold');
        return;
      }
      
      logger.info(`Found ${topScoringTokens.length} promising top gainers`);
      
      // Process each promising token
      for (const scoredToken of topScoringTokens) {
        await this.evaluateAndTrade(scoredToken.token);
      }
    } catch (error) {
      logger.error(`Error processing top gainers: ${error.message}`);
    }
  }

  async processVolumeSpikes(volumeSpikes) {
    try {
      // Ensure volumeSpikes is an array
      if (!Array.isArray(volumeSpikes)) {
        logger.warn('processVolumeSpikes received non-array input');
        return;
      }
      
      // Check if array is empty
      if (volumeSpikes.length === 0) {
        logger.debug('No volume spikes to process');
        return;
      }
      
      // Get top scoring tokens with volume spikes
      const topScoringTokens = await tokenScorer.getTopScoringTokens(volumeSpikes, 0.75, 2);
      
      if (topScoringTokens.length === 0) {
        logger.info('No volume spikes met the score threshold');
        return;
      }
      
      logger.info(`Found ${topScoringTokens.length} promising tokens with volume spikes`);
      
      // Process each promising token
      for (const scoredToken of topScoringTokens) {
        await this.evaluateAndTrade(scoredToken.token);
      }
    } catch (error) {
      logger.error(`Error processing volume spikes: ${error.message}`);
    }
  }

  async evaluateAndTrade(token) {
    try {
      const tokenAddress = token.baseToken.address;
      const tokenSymbol = token.baseToken.symbol;
      
      logger.info(`Evaluating token for trading: ${tokenSymbol} (${tokenAddress})`);
      
      // Check if trading is enabled
      if (!config.trading.enabled) {
        logger.info(`Trading is disabled, skipping trade for ${tokenSymbol}`);
        return;
      }
      
      // Check if we're already in this trade
      const activeTrades = pnlTracker.getActiveTrades();
      if (activeTrades.some(trade => trade.tokenAddress === tokenAddress)) {
        logger.info(`Already in a trade for ${tokenSymbol}, skipping`);
        return;
      }
      
      // Check if we've reached the maximum number of concurrent transactions
      if (this.activeTransactions >= this.maxConcurrentTransactions) {
        logger.info(`Maximum concurrent transactions (${this.maxConcurrentTransactions}) reached, skipping trade for ${tokenSymbol}`);
        return;
      }
      
      // Special handling for LOL token
      if (tokenAddress === 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv') {
        logger.info(`Detected LOL token, using specialized swap execution`);
        return await this.executeLolTokenTrade(token);
      }
      
      // Analyze token on-chain
      await onChainAnalyzer.analyzeToken(tokenAddress);
      
      // Check if token is safe
      const safetyCheck = await riskFilter.isTokenSafe(tokenAddress);
      
      if (!safetyCheck.isSafe) {
        logger.warn(`Token ${tokenSymbol} failed safety check: ${safetyCheck.reasons.join(', ')}`);
        
        // Track rejected token for reinforcement learning
        const scores = await tokenScorer.getDetailedScores(tokenAddress);
        await reinforcementLearning.trackRejectedToken(token, `Safety: ${safetyCheck.reasons.join(', ')}`, scores);
        
        return;
      }
      
      // Check if token is tradable on Jupiter or other DEXes
      const tradabilityCheck = await this.isTokenTradableOnJupiter(tokenAddress);
      
      if (!tradabilityCheck.tradable) {
        logger.warn(`Token ${tokenSymbol} is not tradable on any supported DEX: ${tradabilityCheck.reason}`);
        
        // Track rejected token for reinforcement learning
        const scores = await tokenScorer.getDetailedScores(tokenAddress);
        await reinforcementLearning.trackRejectedToken(token, `Not tradable: ${tradabilityCheck.reason}`, scores);
        
        return;
      }
      
      logger.info(`Token ${tokenSymbol} is tradable on ${tradabilityCheck.dex}`);
      
      // Simulate swap to verify tradability
      const swapSimulation = await onChainAnalyzer.simulateSwap(tokenAddress, tradabilityCheck.dex);
      
      if (!swapSimulation.success) {
        logger.warn(`Swap simulation failed for ${tokenSymbol} on ${tradabilityCheck.dex}: ${swapSimulation.error || 'Unknown error'}`);
        
        // Track rejected token for reinforcement learning
        const scores = await tokenScorer.getDetailedScores(tokenAddress);
        await reinforcementLearning.trackRejectedToken(token, `Swap simulation failed: ${swapSimulation.error || 'Unknown error'}`, scores);
        
        return;
      }
      
      // All checks passed, execute the trade
      logger.info(`All checks passed for ${tokenSymbol}, executing trade`);
      
      // Increment active transactions counter
      this.activeTransactions++;
      logger.info(`Active transactions: ${this.activeTransactions}/${this.maxConcurrentTransactions}`);
      
      // Use testMode for trade size if enabled
      const tradeSizeSol = config.trading.testMode ? 
        Math.min(0.005, this.maxTradeSizeSol) : 
        this.maxTradeSizeSol;
      
      // Get optimal slippage for the selected DEX
      const slippage = await swapExecutor.getOptimalSlippage(tokenAddress, tradabilityCheck.dex);
      
      // Execute the swap on the selected DEX
      const swapResult = await swapExecutor.executeSwap(tokenAddress, tradeSizeSol, slippage, tradabilityCheck.dex);
      
      if (swapResult.success) {
        logger.info(`Successfully bought ${tokenSymbol} for ${tradeSizeSol} SOL on ${tradabilityCheck.dex}`);
        
        // Log event
        await database.logEvent(
          'TRADE_EXECUTED',
          `Bought ${tokenSymbol} for ${tradeSizeSol} SOL on ${tradabilityCheck.dex}`,
          {
            tokenAddress,
            tokenSymbol,
            amountIn: tradeSizeSol,
            txHash: swapResult.txHash,
            dex: tradabilityCheck.dex
          }
        );
        
        // Decrement active transactions counter on success after a delay
        // This gives time for the transaction to be processed
        setTimeout(() => {
          this.activeTransactions = Math.max(0, this.activeTransactions - 1);
          logger.info(`Active transactions decremented: ${this.activeTransactions}/${this.maxConcurrentTransactions}`);
        }, 60000); // 1 minute delay
      } else {
        logger.error(`Failed to buy ${tokenSymbol}: ${swapResult.error}`);
        
        // Track rejected token for reinforcement learning
        const scores = await tokenScorer.getDetailedScores(tokenAddress);
        await reinforcementLearning.trackRejectedToken(token, `Swap execution failed: ${swapResult.error}`, scores);
        
        // Decrement active transactions counter on failure
        this.activeTransactions--;
        logger.info(`Active transactions: ${this.activeTransactions}/${this.maxConcurrentTransactions}`);
      }
    } catch (error) {
      logger.error(`Error evaluating and trading token: ${error.message}`);
      // Ensure we decrement the counter in case of errors
      this.activeTransactions = Math.max(0, this.activeTransactions - 1);
      logger.info(`Active transactions: ${this.activeTransactions}/${this.maxConcurrentTransactions}`);
    }
  }

  async checkTakeProfitStopLoss() {
    try {
      const tradesChecked = await pnlTracker.checkTakeProfitStopLoss();
      if (tradesChecked > 0) {
        logger.info(`Checked TP/SL for ${tradesChecked} trades`);
      }
    } catch (error) {
      logger.error(`Error checking TP/SL: ${error.message}`);
    }
  }

  async updateActiveTradePrices() {
    try {
      const activeTrades = pnlTracker.getActiveTrades();
      
      if (activeTrades.length === 0) {
        return;
      }
      
      logger.debug(`Updating prices for ${activeTrades.length} active trades`);
      
      for (const trade of activeTrades) {
        try {
          // This is a simplified implementation
          // In a real implementation, you would fetch the current price from DEX
          
          // For now, we'll simulate price updates with small random changes
          const randomChange = (Math.random() - 0.4) * 0.05; // -2% to +3% change
          const newPrice = trade.currentPrice * (1 + randomChange);
          
          await pnlTracker.updateTradePrice(trade.tokenAddress, newPrice);
        } catch (error) {
          logger.error(`Error updating price for ${trade.tokenSymbol}: ${error.message}`);
        }
      }
    } catch (error) {
      logger.error(`Error updating active trade prices: ${error.message}`);
    }
  }
  
  /**
   * Reset active transactions counter if it's out of sync with actual trades
   */
  /**
   * Execute a trade specifically for LOL token
   * @param {Object} token - Token information
   * @returns {Promise<void>}
   */
  async executeLolTokenTrade(token) {
    try {
      const tokenAddress = token.baseToken.address;
      const tokenSymbol = token.baseToken.symbol;
      
      logger.info(`Executing specialized LOL token trade for ${tokenSymbol} (${tokenAddress})`);
      
      // Check if we're already in this trade
      const activeTrades = pnlTracker.getActiveTrades();
      if (activeTrades.some(trade => trade.tokenAddress === tokenAddress)) {
        logger.info(`Already in a trade for ${tokenSymbol}, skipping`);
        return;
      }
      
      // Increment active transactions counter
      this.activeTransactions++;
      logger.info(`Active transactions: ${this.activeTransactions}/${this.maxConcurrentTransactions}`);
      
      // Use testMode for trade size if enabled
      const tradeSizeSol = config.trading.testMode ? 
        Math.min(0.005, this.maxTradeSizeSol) : 
        this.maxTradeSizeSol;
      
      // Use specialized LOL token swap with 1% slippage
      const slippage = 1.0; // 1% slippage for LOL token
      
      // Execute the specialized LOL token swap
      const swapResult = await swapExecutor.executeLolTokenSwap(tradeSizeSol, slippage);
      
      if (swapResult.success) {
        logger.info(`Successfully bought ${tokenSymbol} for ${tradeSizeSol} SOL using specialized LOL token swap`);
        
        // Log event
        await database.logEvent(
          'TRADE_EXECUTED',
          `Bought ${tokenSymbol} for ${tradeSizeSol} SOL using specialized LOL token swap`,
          {
            tokenAddress,
            tokenSymbol,
            amountIn: tradeSizeSol,
            txHash: swapResult.txHash,
            dex: 'Raydium',
            specialized: true
          }
        );
        
        // Decrement active transactions counter on success after a delay
        // This gives time for the transaction to be processed
        setTimeout(() => {
          this.activeTransactions = Math.max(0, this.activeTransactions - 1);
          logger.info(`Active transactions decremented: ${this.activeTransactions}/${this.maxConcurrentTransactions}`);
        }, 60000); // 1 minute delay
      } else {
        logger.error(`Failed to buy ${tokenSymbol} using specialized LOL token swap: ${swapResult.error}`);
        
        // Track rejected token for reinforcement learning
        const scores = await tokenScorer.getDetailedScores(tokenAddress);
        await reinforcementLearning.trackRejectedToken(token, `Specialized swap execution failed: ${swapResult.error}`, scores);
        
        // Decrement active transactions counter on failure
        this.activeTransactions--;
        logger.info(`Active transactions: ${this.activeTransactions}/${this.maxConcurrentTransactions}`);
      }
    } catch (error) {
      logger.error(`Error executing specialized LOL token trade: ${error.message}`);
      // Ensure we decrement the counter in case of errors
      this.activeTransactions = Math.max(0, this.activeTransactions - 1);
      logger.info(`Active transactions: ${this.activeTransactions}/${this.maxConcurrentTransactions}`);
    }
  }
  
  /**
   * Reset active transactions counter if it's out of sync with actual trades
   */
  async resetActiveTransactionsIfNeeded() {
    try {
      const activeTrades = pnlTracker.getActiveTrades();
      
      // If active transactions counter is higher than actual trades, reset it
      if (this.activeTransactions > activeTrades.length) {
        logger.warn(`Active transactions counter (${this.activeTransactions}) is higher than actual trades (${activeTrades.length}). Resetting.`);
        this.activeTransactions = activeTrades.length;
        logger.info(`Active transactions counter reset to ${this.activeTransactions}`);
      }
    } catch (error) {
      logger.error(`Error resetting active transactions counter: ${error.message}`);
    }
  }
  
  /**
   * Check if a token is tradable on Raydium
   * @param {string} tokenAddress - The address of the token to check
   * @returns {Promise<{tradable: boolean, reason: string|null, liquidity: number|null}>}
   */
  async checkRaydiumTradability(tokenAddress) {
    try {
      logger.debug(`Checking if token ${tokenAddress} is tradable on Raydium`);
      
      // Implement Raydium-specific checks here
      // This would typically involve:
      // 1. Checking if the token has a pool on Raydium
      // 2. Checking if there's sufficient liquidity
      // 3. Checking if swaps are possible
      
      // For now, we'll use a simplified implementation that checks for pool existence
      const raydiumPoolExists = await onChainAnalyzer.checkRaydiumPool(tokenAddress);
      
      if (!raydiumPoolExists) {
        return { tradable: false, reason: 'No Raydium pool found', liquidity: null };
      }
      
      // Check liquidity on Raydium
      const raydiumLiquidity = await onChainAnalyzer.getRaydiumLiquidity(tokenAddress);
      
      if (raydiumLiquidity < config.trading.minLiquidityUsd) {
        return { 
          tradable: false, 
          reason: `Insufficient liquidity on Raydium: ${raydiumLiquidity.toFixed(2)} < ${config.trading.minLiquidityUsd}`,
          liquidity: raydiumLiquidity
        };
      }
      
      // If we get here, the token is tradable on Raydium
      return { tradable: true, reason: null, liquidity: raydiumLiquidity };
    } catch (error) {
      logger.error(`Error checking if token is tradable on Raydium: ${error.message}`);
      return { tradable: false, reason: `Error: ${error.message}`, liquidity: null };
    }
  }
  
  /**
   * Check if a token is tradable on Orca
   * @param {string} tokenAddress - The address of the token to check
   * @returns {Promise<{tradable: boolean, reason: string|null, liquidity: number|null}>}
   */
  async checkOrcaTradability(tokenAddress) {
    try {
      logger.debug(`Checking if token ${tokenAddress} is tradable on Orca`);
      
      // Implement Orca-specific checks here
      // This would typically involve:
      // 1. Checking if the token has a pool on Orca
      // 2. Checking if there's sufficient liquidity
      // 3. Checking if swaps are possible
      
      // For now, we'll use a simplified implementation that checks for pool existence
      const orcaPoolExists = await onChainAnalyzer.checkOrcaPool(tokenAddress);
      
      if (!orcaPoolExists) {
        return { tradable: false, reason: 'No Orca pool found', liquidity: null };
      }
      
      // Check liquidity on Orca
      const orcaLiquidity = await onChainAnalyzer.getOrcaLiquidity(tokenAddress);
      
      if (orcaLiquidity < config.trading.minLiquidityUsd) {
        return { 
          tradable: false, 
          reason: `Insufficient liquidity on Orca: ${orcaLiquidity.toFixed(2)} < ${config.trading.minLiquidityUsd}`,
          liquidity: orcaLiquidity
        };
      }
      
      // If we get here, the token is tradable on Orca
      return { tradable: true, reason: null, liquidity: orcaLiquidity };
    } catch (error) {
      logger.error(`Error checking if token is tradable on Orca: ${error.message}`);
      return { tradable: false, reason: `Error: ${error.message}`, liquidity: null };
    }
  }
  
  /**
   * Check if a token is tradable on Jupiter or alternative DEXes
   * @param {string} tokenAddress - The address of the token to check
   * @returns {Promise<{tradable: boolean, reason: string|null, dex: string|null}>} - Result object with tradable status, reason if not tradable, and the DEX where it's tradable
   */
  async isTokenTradableOnJupiter(tokenAddress) {
    try {
      logger.debug(`Checking if token ${tokenAddress} is tradable on Jupiter`);
      
      // First, validate the token address format
      if (!tokenAddress || typeof tokenAddress !== 'string' || tokenAddress.length < 32) {
        return { tradable: false, reason: 'Invalid token address format', dex: null };
      }
      
      // Check if the token exists on-chain
      const tokenInfo = await onChainAnalyzer.analyzeToken(tokenAddress);
      if (!tokenInfo || (tokenInfo.address && tokenInfo.address !== tokenAddress)) {
        return { tradable: false, reason: 'Token does not exist on-chain', dex: null };
      }
      
      // Try to get Jupiter routes for the token
      const jupiterRoutesCheck = await swapExecutor.checkJupiterTradability(tokenAddress);
      
      // If Jupiter has routes, check liquidity and return success
      if (jupiterRoutesCheck.success) {
        // Check if there's enough liquidity on Jupiter
        if (jupiterRoutesCheck.liquidity && jupiterRoutesCheck.liquidity < config.trading.minLiquidityUsd) {
          logger.info(`Token ${tokenAddress} has insufficient liquidity on Jupiter: ${jupiterRoutesCheck.liquidity.toFixed(2)} < ${config.trading.minLiquidityUsd}`);
        } else {
          logger.debug(`Token ${tokenAddress} is tradable on Jupiter`);
          return { tradable: true, reason: null, dex: 'Jupiter' };
        }
      } else {
        logger.info(`Token ${tokenAddress} not tradable on Jupiter: ${jupiterRoutesCheck.error || 'No viable swap routes found'}`);
      }
      
      // If we get here, the token is not tradable on Jupiter, check Raydium
      logger.info(`Checking if token ${tokenAddress} is tradable on Raydium`);
      const raydiumCheck = await this.checkRaydiumTradability(tokenAddress);
      
      if (raydiumCheck.tradable) {
        logger.info(`Token ${tokenAddress} is tradable on Raydium`);
        return { tradable: true, reason: null, dex: 'Raydium' };
      }
      
      // Check other DEXes if needed
      // For example, check Orca
      logger.info(`Checking if token ${tokenAddress} is tradable on Orca`);
      const orcaCheck = await this.checkOrcaTradability(tokenAddress);
      
      if (orcaCheck.tradable) {
        logger.info(`Token ${tokenAddress} is tradable on Orca`);
        return { tradable: true, reason: null, dex: 'Orca' };
      }
      
      // If we get here, the token is not tradable on any supported DEX
      return { 
        tradable: false, 
        reason: 'Token not tradable on any supported DEX (Jupiter, Raydium, Orca)', 
        dex: null 
      };
    } catch (error) {
      logger.error(`Error checking if token is tradable: ${error.message}`);
      return { tradable: false, reason: `Error: ${error.message}`, dex: null };
    }
  }
  
  async shutdown() {
    try {
      logger.info('Shutting down Kairos Meme Bot...');
      
      // Stop RPC health monitor
      rpcHealthMonitor.stop();
      logger.info('RPC health monitor stopped');
      
      // Log final RPC metrics
      const rpcMetrics = rpcManager.getEndpointMetrics();
      logger.info(`Final RPC metrics: ${JSON.stringify(rpcMetrics)}`);
      
      // Save reinforcement learning data
      await reinforcementLearning.saveMemory();
      logger.info('Reinforcement learning data saved');
      
      // Close database connection
      await database.close();
      
      // Shutdown dashboard
      dashboard.shutdown();
      
      logger.info('Shutdown complete');
    } catch (error) {
      logger.error(`Error during shutdown: ${error.message}`);
    }
  }
}

// Create and start the bot
const bot = new KairosMemeBot();

// Export the bot instance for other modules to access
module.exports = { bot };

// Handle process termination
process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal');
  await bot.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal');
  await bot.shutdown();
  process.exit(0);
});

// Initialize and start the bot
bot.initialize().then(success => {
  if (success) {
    logger.info('Kairos Meme Bot started successfully');
    bot.scanMarket(); // Run initial scan
  } else {
    logger.error('Failed to start Kairos Meme Bot');
    process.exit(1);
  }
});