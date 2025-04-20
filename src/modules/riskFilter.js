const { Connection, PublicKey } = require('@solana/web3.js');
const config = require('../../config/config');
const logger = require('../utils/logger');
const database = require('../utils/database');
const onChainAnalyzer = require('./onChainAnalyzer');

class RiskFilter {
  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, 'confirmed');
    this.blacklistedFunctions = [
      'blacklist',
      'ban',
      'block',
      'exclude',
      'pause',
      'freeze',
    ];
    this.blacklistedTokens = new Set();
    this.whitelistedTokens = new Set([
      'ER7qoXEsKfmmLehwmZaK1WVoDTxSBWsnqEKgcVYFpump', // ◎ token
      'fESbUKjuMY6jzDH9VP8cy4p3pu2q5W2rK2XghVfNseP', // SOLANA token
      'So11111111111111111111111111111111111111112', // Wrapped SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
      'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk', // WEN
      'F3nefJBcejYbtdREjui1T9DPh5dBgpkKq7u2GAAMXs5B', // PYTH
      'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // MSOL
      'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
      'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', // PYTH
      'AFbX8oGjGpmVFywbVouvhQSRmiW2aR1mohfahi4Y2AdB', // GST
      '7i5KKsX2weiTkry7jA4ZwSuXGhs5eJBEjY8vVxR4pfRx', // GMT
      'kinXdEcpDQeHPEuQnqmUgtYykqKGVFq6CeVX5iAHJq6', // KIN
      'HxRELUQfvvjToVbacjr9YECdfQMUqGgPYB68jVDYxkbr', // NANA
      'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WOOF
      'HCgybxq5Upy8Mccihrp7EsmwwFqYZtrHrsmsKwtGXLgW', // SAMO
      'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey', // MNDE
      'SHDWyBxihqiCj6YekG2GUr7wqKLeLAMK1gHZck9pL6y', // SHDW
      'zebeczgi5fSEtbpfQKVZKCJ3WgYXxjkMUkNNx7fLKAF', // ZBC
      'BLwTnYKqf7u4qjgZrrsKeNs2EzWkMLqVCu6j8iHyrNA3', // BLT
      'Saber2gLauYim4Mvftnrasomsv6NvAuncvMEZwcLpD1', // SBR
      'MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac', // MNGO
      'StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Yp39iDpyT', // STEP
      'CASHVDm2wsJXfhj6VWxb7GiMdoLc17Du7paH4bNr5woT', // CASH
      'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', // ORCA
      'RLBxxFkseAZ4RgJH3Sqn8jXxhmGoz9jWxDNJMh8pL7a', // RLB
      'DFL1zNkaGPWm1BqAVqRjCZvHmwTFrEaJtbzJWgseoNJh', // DFL
      'HfYFjMKNZygfMC8LsQ8LtpPsPxEJoXJx4M6tqi75Hajo', // CWAR
      'BRENm9SgYAEVYmQrZJQwcjJAqmw7W3oRsJBesHiDR2m3', // BREN
      'WIFZBdYP3XfzJEfryJjEjKdY1mHQGQxXgELLcEL1ZuT', // WIF
      'AiEXZFNs4Af1L8oCQnQTrTJ1Fv8i3KKqPfPx2SDjRCQr', // AI
      'METAmTMXwdb8gYzyCPfXXFmZZw4rUsXX58PNsDg7zjL', // META
      // Add any other tokens you want to whitelist
    ]);
    
    // Trading monitoring stats
    this.tradingStats = {
      passedEvaluation: 0,
      successfulTrades: 0,
      failedTrades: 0,
      tokenPerformance: new Map() // Track performance by token address
    };
  }

  async analyzeTokenRisk(tokenAddress) {
    try {
      logger.info(`Analyzing risk for token: ${tokenAddress}`);
      
      // Check if token is whitelisted
      if (this.whitelistedTokens.has(tokenAddress)) {
        logger.info(`Token ${tokenAddress} is whitelisted, bypassing safety checks`);
        return {
          isRisky: false,
          riskScore: 0.2,
          reasons: ['Whitelisted token'],
        };
      }
      
      // Check if token is blacklisted
      if (this.blacklistedTokens.has(tokenAddress)) {
        logger.warn(`Token is blacklisted: ${tokenAddress}`);
        return {
          isRisky: true,
          riskScore: 1.0,
          reasons: ['Token is blacklisted'],
        };
      }
      
      // Get on-chain data
      const onChainData = await onChainAnalyzer.analyzeToken(tokenAddress);
      if (!onChainData) {
        return {
          isRisky: true,
          riskScore: 0.8,
          reasons: ['Failed to fetch on-chain data'],
        };
      }
      
      // Check if mint authority is revoked
      const mintAuthorityRevoked = onChainData.mintAuthorityRevoked;
      
      // Simulate a swap to check if token is tradable
      const swapSimulation = await onChainAnalyzer.simulateSwap(tokenAddress);
      
      // Get token data from database
      const tokenData = await database.getToken(tokenAddress);
      
      // Calculate risk score and collect risk reasons
      let riskScore = 0;
      const reasons = [];
      
      // Check mint authority - reduced weight
      if (!mintAuthorityRevoked) {
        riskScore += 0.2; // Reduced from 0.4
        reasons.push('Mint authority not revoked');
      }
      
      // Check liquidity
      const liquidity = tokenData?.liquidity || 0;
      if (liquidity < config.trading.minLiquidityUsd) {
        riskScore += 0.2; // Reduced from 0.3
        reasons.push(`Low liquidity: ${liquidity}`);
      }
      
      // Check swap simulation
      if (!swapSimulation.success) {
        riskScore += 0.3; // Reduced from 0.5
        reasons.push('Swap simulation failed');
      }
      
      if (!swapSimulation.canSellBack) {
        riskScore += 0.4; // Reduced from 0.8
        reasons.push('Cannot sell token (honeypot)');
      }
      
      // Check holders count - more lenient
      const holdersCount = onChainData.holdersCount || 0;
      // Only add risk if holder count is extremely low
      if (holdersCount < 5) {
        riskScore += 0.1; // Reduced from 0.2
        reasons.push(`Low holder count: ${holdersCount}`);
      }
      
      // Normalize risk score to 0-1 range
      riskScore = Math.min(1, riskScore);
      
      const result = {
        isRisky: riskScore > 0.7, // Increased threshold from 0.5 to 0.7
        riskScore,
        reasons,
      };
      
      logger.info(`Risk analysis for ${tokenAddress}: Score ${riskScore.toFixed(2)}, Risky: ${result.isRisky}`);
      return result;
    } catch (error) {
      logger.error(`Error analyzing token risk: ${error.message}`);
      return {
        isRisky: true,
        riskScore: 0.8,
        reasons: ['Error during risk analysis: ' + error.message],
      };
    }
  }

  async checkForHoneypot(tokenAddress) {
    try {
      logger.info(`Checking for honeypot: ${tokenAddress}`);
      
      // Simulate buy and sell to check if token is a honeypot
      const buySimulation = await onChainAnalyzer.simulateSwap(tokenAddress);
      
      if (!buySimulation.success) {
        logger.warn(`Buy simulation failed for token: ${tokenAddress}`);
        return {
          isHoneypot: true,
          reason: 'Cannot buy token',
        };
      }
      
      // This is a placeholder for sell simulation
      // In a real implementation, you would simulate selling the token
      const sellSimulation = {
        success: true, // Placeholder
      };
      
      if (!sellSimulation.success) {
        logger.warn(`Sell simulation failed for token: ${tokenAddress}`);
        return {
          isHoneypot: true,
          reason: 'Cannot sell token',
        };
      }
      
      logger.info(`Honeypot check passed for token: ${tokenAddress}`);
      return {
        isHoneypot: false,
      };
    } catch (error) {
      logger.error(`Error checking for honeypot: ${error.message}`);
      return {
        isHoneypot: true,
        reason: 'Error during honeypot check: ' + error.message,
      };
    }
  }

  async checkForRugPull(tokenAddress) {
    try {
      logger.info(`Checking for rug pull risk: ${tokenAddress}`);
      
      // Get on-chain data
      const onChainData = await onChainAnalyzer.analyzeToken(tokenAddress);
      
      // Get token data from database
      const tokenData = await database.getToken(tokenAddress);
      
      // Calculate rug pull risk
      let rugPullRisk = 0;
      const reasons = [];
      
      // Check mint authority
      if (!onChainData?.mintAuthorityRevoked) {
        rugPullRisk += 0.5;
        reasons.push('Mint authority not revoked');
      }
      
      // Check liquidity
      const liquidity = tokenData?.liquidity || 0;
      if (liquidity < 10000) {
        rugPullRisk += 0.3;
        reasons.push(`Low liquidity: ${liquidity}`);
      }
      
      // Check holders distribution (simplified)
      const holdersCount = onChainData?.holdersCount || 0;
      if (holdersCount < 20) {
        rugPullRisk += 0.2;
        reasons.push(`Low holder count: ${holdersCount}`);
      }
      
      // Normalize risk score to 0-1 range
      rugPullRisk = Math.min(1, rugPullRisk);
      
      const result = {
        isRugPullRisk: rugPullRisk > 0.5,
        rugPullRisk,
        reasons,
      };
      
      logger.info(`Rug pull risk for ${tokenAddress}: ${rugPullRisk.toFixed(2)}`);
      return result;
    } catch (error) {
      logger.error(`Error checking for rug pull risk: ${error.message}`);
      return {
        isRugPullRisk: true,
      };
    }
  }
  
  async checkForRugPull(tokenAddress) {
    try {
      logger.info(`Checking for rug pull risk: ${tokenAddress}`);
      
      // For well-known tokens, bypass the rug pull check
      if (this.whitelistedTokens.has(tokenAddress)) {
        return {
          isRugPullRisk: false,
          rugPullRisk: 0.1,
          reasons: ['Whitelisted token'],
        };
      }
      
      // Get on-chain data
      const onChainData = await onChainAnalyzer.analyzeToken(tokenAddress);
      
      // Get token data from database
      const tokenData = await database.getToken(tokenAddress);
      
      // Calculate rug pull risk
      let rugPullRisk = 0;
      const reasons = [];
      
      // Check mint authority - reduced weight
      if (!onChainData?.mintAuthorityRevoked) {
        rugPullRisk += 0.3; // Reduced from 0.5
        reasons.push('Mint authority not revoked');
      }
      
      // Check liquidity - reduced threshold
      const liquidity = tokenData?.liquidity || 0;
      if (liquidity < 5000) { // Reduced from 10000
        rugPullRisk += 0.2; // Reduced from 0.3
        reasons.push(`Low liquidity: ${liquidity}`);
      }
      
      // Check holders distribution - reduced threshold
      const holdersCount = onChainData?.holdersCount || 0;
      if (holdersCount < 10) { // Reduced from 20
        rugPullRisk += 0.1; // Reduced from 0.2
        reasons.push(`Low holder count: ${holdersCount}`);
      }
      
      // Normalize risk score to 0-1 range
      rugPullRisk = Math.min(1, rugPullRisk);
      
      const result = {
        isRugPullRisk: rugPullRisk > 0.6, // Increased threshold from 0.5 to 0.6
        rugPullRisk,
        reasons,
      };
      
      logger.info(`Rug pull risk for ${tokenAddress}: ${rugPullRisk.toFixed(2)}`);
      return result;
    } catch (error) {
      logger.error(`Error checking for rug pull risk: ${error.message}`);
      // Be more lenient with errors - don't automatically mark as rug pull risk
      return {
        isRugPullRisk: false,
        rugPullRisk: 0.4,
        reasons: ['Error during rug pull check, assuming moderate risk'],
      };
    }
  }

  async isTokenSafe(tokenAddress) {
    try {
      // Check if token is whitelisted first for efficiency
      if (this.whitelistedTokens.has(tokenAddress)) {
        logger.info(`Token ${tokenAddress} is whitelisted, bypassing safety checks`);
        return {
          isSafe: true,
          reasons: ['Whitelisted token'],
          riskScore: 0.2,
          isHoneypot: false,
          rugPullRisk: 0.2,
          isWhitelisted: true
        };
      }
      
      // Run all risk checks
      const [riskAnalysis, honeypotCheck, rugPullCheck] = await Promise.all([
        this.analyzeTokenRisk(tokenAddress),
        this.checkForHoneypot(tokenAddress),
        this.checkForRugPull(tokenAddress),
      ]);
      
      // More lenient safety check - only fail if multiple checks fail
      // Token is safe if it passes at least 2 out of 3 checks
      let failCount = 0;
      if (riskAnalysis.isRisky) failCount++;
      if (honeypotCheck.isHoneypot) failCount++;
      if (rugPullCheck.isRugPullRisk) failCount++;
      
      const isSafe = failCount < 2; // Only require 2 out of 3 checks to pass
      
      // Collect all reasons if not safe
      const reasons = [];
      if (riskAnalysis.isRisky) {
        reasons.push(...riskAnalysis.reasons);
      }
      if (honeypotCheck.isHoneypot) {
        reasons.push(honeypotCheck.reason || 'Honeypot check failed');
      }
      if (rugPullCheck.isRugPullRisk) {
        reasons.push(...(rugPullCheck.reasons || ['Rug pull risk detected']));
      }
      
      logger.info(`Token safety check for ${tokenAddress}: ${isSafe ? 'SAFE' : 'UNSAFE'}`);
      
      // Record that this token passed evaluation if it's safe
      if (isSafe) {
        this.recordTokenPassedEvaluation(tokenAddress);
      }
      
      return {
        isSafe,
        reasons: isSafe ? [] : reasons,
        riskScore: riskAnalysis.riskScore,
        isHoneypot: honeypotCheck.isHoneypot,
        rugPullRisk: rugPullCheck.rugPullRisk,
        isWhitelisted: false
      };
    } catch (error) {
      logger.error(`Error checking token safety: ${error.message}`);
      // Be more lenient with errors - don't automatically mark as unsafe
      return {
        isSafe: true, // Changed from false to true
        reasons: ['Error during safety check, proceeding with caution'],
        riskScore: 0.6, // Reduced from 1.0
        isHoneypot: false, // Changed from true to false
        rugPullRisk: 0.6, // Reduced from 1.0
        isWhitelisted: false
      };
    }
  }

  // Add a token to the blacklist
  addToBlacklist(tokenAddress, reason = '') {
    this.blacklistedTokens.add(tokenAddress);
    logger.info(`Added token to blacklist: ${tokenAddress} - Reason: ${reason}`);
  }

  // Record a token that passed evaluation
  recordTokenPassedEvaluation(tokenAddress) {
    this.tradingStats.passedEvaluation++;
    
    // Initialize token performance tracking if not exists
    if (!this.tradingStats.tokenPerformance.has(tokenAddress)) {
      this.tradingStats.tokenPerformance.set(tokenAddress, {
        passedEvaluation: 0,
        successfulTrades: 0,
        failedTrades: 0,
        lastTradeTimestamp: null,
        profitLoss: 0
      });
    }
    
    const tokenStats = this.tradingStats.tokenPerformance.get(tokenAddress);
    tokenStats.passedEvaluation++;
    
    logger.info(`Token ${tokenAddress} passed evaluation (${tokenStats.passedEvaluation} times total)`);
    return tokenStats;
  }

  // Record a successful trade
  recordSuccessfulTrade(tokenAddress, profitLoss = 0) {
    this.tradingStats.successfulTrades++;
    
    if (!this.tradingStats.tokenPerformance.has(tokenAddress)) {
      this.recordTokenPassedEvaluation(tokenAddress);
    }
    
    const tokenStats = this.tradingStats.tokenPerformance.get(tokenAddress);
    tokenStats.successfulTrades++;
    tokenStats.lastTradeTimestamp = Date.now();
    tokenStats.profitLoss += profitLoss;
    
    logger.info(`Successful trade for token ${tokenAddress} (${tokenStats.successfulTrades}/${tokenStats.passedEvaluation} success rate)`);
    
    // If this token has a good track record, consider adding to whitelist
    if (tokenStats.successfulTrades >= 3 && tokenStats.failedTrades === 0) {
      logger.info(`Token ${tokenAddress} has a perfect trading record. Consider adding to whitelist.`);
    }
    
    return tokenStats;
  }

  // Record a failed trade
  recordFailedTrade(tokenAddress, reason = '') {
    this.tradingStats.failedTrades++;
    
    if (!this.tradingStats.tokenPerformance.has(tokenAddress)) {
      this.recordTokenPassedEvaluation(tokenAddress);
    }
    
    const tokenStats = this.tradingStats.tokenPerformance.get(tokenAddress);
    tokenStats.failedTrades++;
    tokenStats.lastTradeTimestamp = Date.now();
    
    logger.warn(`Failed trade for token ${tokenAddress}: ${reason} (${tokenStats.failedTrades} failures total)`);
    
    // If this token has failed multiple times, consider blacklisting
    if (tokenStats.failedTrades >= 2) {
      this.addToBlacklist(tokenAddress, `Multiple trade failures: ${reason}`);
    }
    
    return tokenStats;
  }

  // Get trading statistics
  getTradingStats() {
    const successRate = this.tradingStats.passedEvaluation > 0 
      ? (this.tradingStats.successfulTrades / this.tradingStats.passedEvaluation) * 100 
      : 0;
      
    return {
      ...this.tradingStats,
      successRate: `${successRate.toFixed(2)}%`,
      tokenPerformance: Object.fromEntries(this.tradingStats.tokenPerformance)
    };
  }

  // Check if trading is enabled based on environment variables
  isTradingEnabled() {
    return process.env.TRADING_ENABLED === 'true';
  }

  // Check if we're in test mode
  isTestMode() {
    return process.env.TEST_MODE === 'true';
  }
}

module.exports = new RiskFilter();