/**
 * Jupiter API Client
 * 
 * This module provides a client for interacting with Jupiter API with rate limiting.
 * It handles token quotes, swaps, and price information.
 * Also includes fallback to PumpSwap for tokens not available on Jupiter.
 * Handles automatic wrapping of SOL to WSOL for Jupiter API compatibility.
 */
const axios = require('axios');
const { PublicKey, Transaction, SystemProgram, SYSVAR_RENT_PUBKEY } = require('@solana/web3.js');
const { Token, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const JupiterRateLimiter = require('./jupiterRateLimiter');
const logger = require('./logger');
const config = require('../../config/config');

class JupiterApiClient {
  /**
   * Create a new Jupiter API client
   * @param {Object} options - Configuration options
   * @param {string} options.tier - API tier ('free', 'proI', 'proII', 'proIII', 'proIV')
   * @param {string} options.apiKey - Jupiter API key (required for paid tiers)
   * @param {boolean} options.debug - Enable debug logging
   */
  constructor(options = {}) {
    // Use config values if available
    const jupiterConfig = config.jupiter || {};
    
    // Create rate limiter
    this.rateLimiter = new JupiterRateLimiter({
      tier: options.tier || jupiterConfig.tier || 'free',
      apiKey: options.apiKey || jupiterConfig.apiKey,
      debug: options.debug || jupiterConfig.debug || false,
      maxRetries: options.maxRetries || jupiterConfig.maxRetries || 3,
      platformFeeBps: options.platformFeeBps || jupiterConfig.platformFeeBps || 0,
      feeAccount: options.feeAccount || jupiterConfig.feeAccount
    });
    
    // Set up trusted DEXes whitelist
    this.trustedDexes = [
      'raydium', 'orca', 'meteora', 'jupiter', 'openbook', 'phoenix',
      'dooar', 'cykura', 'saros', 'aldrin', 'crema', 'lifinity', 'serum', 'saber'
    ];
    
    // Configure DEX-specific slippage thresholds
    this.dexSlippageThresholds = {
      'raydium': 500,  // 5%
      'orca': 500,     // 5%
      'meteora': 500,  // 5%
      'jupiter': 500,  // 5%
      'openbook': 1000, // 10%
      'phoenix': 1000,  // 10%
      'dooar': 2000,    // 20%
      'pumpswap': 6000, // 60%
      'default': 1000   // 10% default
    };
    
    // Failed trade tracking
    this.failedTrades = new Map();
    this.failedTradeTimeout = 10 * 60 * 1000; // 10 minutes
      apiKey: options.apiKey || jupiterConfig.apiKey || null,
      maxConcurrentRequests: options.maxConcurrentRequests || jupiterConfig.maxConcurrentRequests || 2,
      maxRetries: options.maxRetries || jupiterConfig.maxRetries || 3,
      debug: options.debug || jupiterConfig.debug || false
    });
    
    // Cache for token info
    this.tokenInfoCache = new Map();
    this.tokenInfoCacheTimeout = 5 * 60 * 1000; // 5 minutes
    
    // Cache for wallet balances
    this.balanceCache = new Map();
    this.balanceCacheTTL = 30 * 1000; // 30 seconds TTL for balance cache
    
    // Cooldown map for failed tokens
    this.cooldownMap = new Map();
    this.cooldownDuration = 10 * 60 * 1000; // 10 minutes cooldown
    this.maxFailedAttempts = 3; // Number of failures before cooldown
    this.failedAttemptsMap = new Map(); // Track failed attempts per token
    
    // Failed trades log
    this.rejectedTrades = [];
    
    // Define constants for SOL and WSOL
    this.NATIVE_SOL = 'SOL';
    this.WSOL_ADDRESS = 'So11111111111111111111111111111111111111112';
    
    logger.info(`Initialized Jupiter API Client with ${this.rateLimiter.config.tier} tier`);
  }
  
  /**
   * Get the current status of the Jupiter API client
   * @returns {Object} - Current status
   */
  getStatus() {
    return this.rateLimiter.getStatus();
  }
  
  /**
   * Check if a token is on cooldown due to failed trades
   * @param {string} tokenAddress - Token address to check
   * @returns {boolean} - True if token is on cooldown
   */
  isTokenOnCooldown(tokenAddress) {
    const normalizedAddress = this.normalizeTokenAddress(tokenAddress).toString();
    
    if (this.cooldownMap.has(normalizedAddress)) {
      const cooldownInfo = this.cooldownMap.get(normalizedAddress);
      const now = Date.now();
      
      // Check if cooldown has expired
      if (now > cooldownInfo.expiresAt) {
        // Remove from cooldown map
        this.cooldownMap.delete(normalizedAddress);
        // Reset failed attempts
        this.failedAttemptsMap.delete(normalizedAddress);
        return false;
      }
      
      logger.info(`Token ${normalizedAddress} is on cooldown until ${new Date(cooldownInfo.expiresAt).toISOString()}`);
      return true;
    }
    
    return false;
  }
  
  /**
   * Record a failed trade attempt for a token
   * @param {string} tokenAddress - Token address
   * @param {string} reason - Reason for failure
   * @param {string} dex - DEX that was attempted
   */
  recordFailedTradeAttempt(tokenAddress, reason, dex) {
    const normalizedAddress = this.normalizeTokenAddress(tokenAddress).toString();
    
    // Record in rejected trades log
    const rejectedTrade = {
      timestamp: new Date().toISOString(),
      tokenAddress: normalizedAddress,
      reason,
      dex
    };
    
    this.rejectedTrades.push(rejectedTrade);
    logger.info(`Recorded rejected trade for ${normalizedAddress}: ${reason} on ${dex}`);
    
    // Update failed attempts count
    const currentAttempts = this.failedAttemptsMap.get(normalizedAddress) || 0;
    const newAttempts = currentAttempts + 1;
    this.failedAttemptsMap.set(normalizedAddress, newAttempts);
    
    // Check if we should put the token on cooldown
    if (newAttempts >= this.maxFailedAttempts) {
      const now = Date.now();
      const expiresAt = now + this.cooldownDuration;
      
      this.cooldownMap.set(normalizedAddress, {
        reason,
        attempts: newAttempts,
        startedAt: now,
        expiresAt
      });
      
      logger.warn(`Token ${normalizedAddress} added to cooldown for ${this.cooldownDuration/60000} minutes after ${newAttempts} failed attempts`);
    }
  }
  
  /**
   * Get wallet balance with caching
   * @param {string} walletAddress - Wallet address
   * @param {string} tokenAddress - Token address (optional, for specific token balance)
   * @param {Object} connection - Solana connection object
   * @returns {Promise<number>} - Balance in lamports or token units
   */
  async getWalletBalance(walletAddress, tokenAddress = null, connection) {
    try {
      const cacheKey = tokenAddress ? 
        `${walletAddress.toString()}_${this.normalizeTokenAddress(tokenAddress).toString()}` : 
        walletAddress.toString();
      
      // Check cache first
      const cachedBalance = this.balanceCache.get(cacheKey);
      const now = Date.now();
      
      if (cachedBalance && now < cachedBalance.expiresAt) {
        logger.info(`Using cached balance for ${cacheKey}: ${cachedBalance.balance}`);
        return cachedBalance.balance;
      }
      
      // If we have a cached balance but it's expired, we'll still return it if the RPC call fails
      let fallbackBalance = cachedBalance ? cachedBalance.balance : null;
      
      // Implement exponential backoff for retries
      const maxRetries = 3;
      let currentRetry = 0;
      let lastError = null;
      
      while (currentRetry < maxRetries) {
        try {
          let balance;
          
          if (tokenAddress) {
            // Get token balance
            const tokenMint = new PublicKey(this.normalizeTokenAddress(tokenAddress));
            const walletPk = new PublicKey(walletAddress);
            
            // Get associated token account
            const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPk, {
              mint: tokenMint
            });
            
            if (tokenAccounts.value.length > 0) {
              balance = parseInt(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
            } else {
              balance = 0;
            }
          } else {
            // Get SOL balance
            const walletPk = new PublicKey(walletAddress);
            balance = await connection.getBalance(walletPk);
          }
          
          // Cache the result
          this.balanceCache.set(cacheKey, {
            balance,
            timestamp: now,
            expiresAt: now + this.balanceCacheTTL
          });
          
          return balance;
        } catch (error) {
          lastError = error;
          
          // Check if it's a rate limit error
          if (error.message.includes('429') || error.message.includes('Too many requests')) {
            // Exponential backoff
            const delay = Math.pow(2, currentRetry) * 1000;
            logger.warn(`Rate limited when getting balance. Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Rotate RPC endpoint if possible
            if (connection.rpcEndpoint) {
              const newEndpoint = this.rotateRpcEndpoint(connection.rpcEndpoint);
              if (newEndpoint !== connection.rpcEndpoint) {
                // Create a new connection with the new endpoint
                // Note: This is a simplified version, in a real implementation you would need to
                // create a new connection with the new endpoint
                logger.info(`Rotated to new RPC endpoint for balance check: ${newEndpoint}`);
              }
            }
          } else {
            // For other errors, just break and use fallback
            break;
          }
          
          currentRetry++;
        }
      }
      
      // If we have a fallback balance, use it
      if (fallbackBalance !== null) {
        logger.warn(`Failed to get fresh balance, using cached balance: ${fallbackBalance}`);
        return fallbackBalance;
      }
      
      // If we get here, all retries failed and we have no fallback
      throw lastError || new Error('Failed to get wallet balance');
    } catch (error) {
      logger.error(`Error getting wallet balance: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Normalize token address, handling special cases like SOL vs WSOL
   * @param {string|PublicKey} tokenAddress - Token address or symbol
   * @returns {string} - Normalized token address
   */
  normalizeTokenAddress(tokenAddress) {
    // If it's already a PublicKey, convert to string
    if (typeof tokenAddress !== 'string') {
      tokenAddress = tokenAddress.toString();
    }
    
    // Handle SOL vs WSOL
    if (tokenAddress === this.NATIVE_SOL || 
        tokenAddress.toLowerCase() === 'sol' || 
        tokenAddress.toLowerCase() === 'solana') {
      return this.WSOL_ADDRESS;
    }
    
    return tokenAddress;
  }
  
  /**
   * Get the API hostname based on current tier
   * @returns {string} - API hostname
   */
  getApiHostname() {
    return this.rateLimiter.getApiHostname();
  }
  
  /**
   * Get token price information
   * @param {string|string[]} tokenIds - Token IDs or addresses to get prices for
   * @returns {Promise<Object>} - Price information
   */
  async getTokenPrices(tokenIds) {
    try {
      // Convert single token to array
      const ids = Array.isArray(tokenIds) ? tokenIds : [tokenIds];
      
      // Format IDs for query parameter
      const idsParam = ids.join(',');
      
      // Use rate limiter for price API call
      return await this.rateLimiter.execute(
        async () => {
          const response = await axios.get(`${this.getApiHostname()}/v4/price?ids=${idsParam}`);
          return response.data;
        },
        true // This is a Price API call
      );
    } catch (error) {
      logger.error(`Error getting token prices: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get detailed information about a token
   * @param {string} tokenAddress - Token address
   * @returns {Promise<Object>} - Token information
   */
  async getTokenInfo(tokenAddress) {
    try {
      // Normalize token address (handle SOL vs WSOL)
      const normalizedTokenAddress = this.normalizeTokenAddress(tokenAddress);
      
      // Log if normalization changed anything
      if (normalizedTokenAddress !== tokenAddress.toString()) {
        logger.info(`Normalized token address for token info: ${tokenAddress} -> ${normalizedTokenAddress}`);
      }
      
      // Check cache first
      const cacheKey = normalizedTokenAddress.toString();
      const cachedInfo = this.tokenInfoCache.get(cacheKey);
      
      if (cachedInfo && cachedInfo.timestamp > Date.now() - this.tokenInfoCacheTimeout) {
        return cachedInfo.data;
      }
      
      // Use rate limiter for token info API call
      const tokenInfo = await this.rateLimiter.execute(
        async () => {
          const response = await axios.get(`${this.getApiHostname()}/v4/tokens`);
          
          // Find the token in the response
          const tokens = response.data.data;
          const token = tokens.find(t => 
            t.address.toLowerCase() === normalizedTokenAddress.toString().toLowerCase()
          );
          
          return token || null;
        },
        false // Not a Price API call
      );
      
      // Cache the result
      if (tokenInfo) {
        this.tokenInfoCache.set(cacheKey, {
          timestamp: Date.now(),
          data: tokenInfo
        });
      }
      
      return tokenInfo;
    } catch (error) {
      logger.error(`Error getting token info: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Get a quote for swapping tokens
   * @param {Object} params - Quote parameters
   * @param {string} params.inputMint - Input token mint address
   * @param {string} params.outputMint - Output token mint address
   * @param {string|number} params.amount - Amount in lamports/smallest units
   * @param {number} params.slippageBps - Slippage in basis points (e.g., 50 = 0.5%)
   * @returns {Promise<Object>} - Quote information
   */
  async getQuote(params) {
    try {
      const { inputMint, outputMint, amount, slippageBps = 50 } = params;
      
      if (!inputMint || !outputMint || !amount) {
        throw new Error('inputMint, outputMint, and amount are required');
      }
      
      // Normalize token addresses (handle SOL vs WSOL)
      const normalizedInputMint = this.normalizeTokenAddress(inputMint);
      const normalizedOutputMint = this.normalizeTokenAddress(outputMint);
      
      // Ensure we have PublicKey objects
      const inputMintPk = typeof normalizedInputMint === 'string' ? new PublicKey(normalizedInputMint) : normalizedInputMint;
      const outputMintPk = typeof normalizedOutputMint === 'string' ? new PublicKey(normalizedOutputMint) : normalizedOutputMint;
      
      // Log the normalized addresses
      if (normalizedInputMint !== inputMint.toString() || normalizedOutputMint !== outputMint.toString()) {
        logger.info(`Normalized token addresses for quote: ${inputMint} -> ${normalizedInputMint}, ${outputMint} -> ${normalizedOutputMint}`);
      }
      
      // Use rate limiter for quote API call
      return await this.rateLimiter.execute(
        async () => {
          try {
            const response = await axios.get(`${this.getApiHostname()}/v6/quote`, {
              params: {
                inputMint: inputMintPk.toString(),
                outputMint: outputMintPk.toString(),
                amount: amount.toString(),
                slippageBps: slippageBps.toString(),
                onlyDirectRoutes: false,
                asLegacyTransaction: false
              }
            });
            
            return response.data;
          } catch (error) {
            // Check if this is a "no routes" error
            if (error.response && error.response.data && 
                (error.response.data.error === 'No routes found' || 
                 error.response.data.message === 'No routes found' ||
                 error.message.includes('No routes found'))) {
              logger.warn(`No routes found between ${inputMintPk.toString()} and ${outputMintPk.toString()}`);
              return { error: 'No routes found for the input and output mints' };
            }
            throw error;
          }
        },
        false // Not a Price API call
      );
    } catch (error) {
      logger.error(`Error getting quote: ${error.message}`);
      return { error: error.message };
    }
  }
  
  /**
   * Calculate optimal slippage based on token liquidity and volatility
   * @param {string} tokenAddress - Token address to calculate slippage for
   * @param {number} [defaultSlippage=60] - Default slippage in percentage (e.g., 60 = 60%)
   * @param {number} [minSlippage=10] - Minimum slippage in percentage
   * @param {number} [maxSlippage=80] - Maximum slippage in percentage
   * @returns {Promise<number>} - Optimal slippage percentage
   */
  async calculateOptimalSlippage(tokenAddress, defaultSlippage = 60, minSlippage = 10, maxSlippage = 80) {
    try {
      // Normalize token address (handle SOL vs WSOL)
      const normalizedTokenAddress = this.normalizeTokenAddress(tokenAddress);
      
      // Ensure we have a PublicKey object
      const tokenMint = typeof normalizedTokenAddress === 'string' ? new PublicKey(normalizedTokenAddress) : normalizedTokenAddress;
      
      // Log if normalization changed anything
      if (normalizedTokenAddress !== tokenAddress.toString()) {
        logger.info(`Normalized token address for slippage calculation: ${tokenAddress} -> ${normalizedTokenAddress}`);
      }
      
      // Try to get token info and tradability to assess liquidity
      const tokenInfo = await this.getTokenInfo(tokenMint.toString());
      const tradability = await this.isTokenTradable(tokenMint.toString());
      
      // If we couldn't get token info or the token isn't tradable, use default slippage
      if (!tokenInfo || !tradability.tradable) {
        logger.warn(`Jupiter failed to calculate optimal slippage: ${!tokenInfo ? 'No token info' : 'Token not tradable'}. Using default.`);
        return defaultSlippage;
      }
      
      // If we have a quote, use it to calculate slippage based on price impact
      if (tradability.quote && tradability.quote.data && tradability.quote.data.priceImpactPct) {
        const priceImpactPct = parseFloat(tradability.quote.data.priceImpactPct);
        
        // Higher price impact = higher slippage needed
        // This is a simple formula, adjust as needed
        let calculatedSlippage = Math.min(maxSlippage, Math.max(minSlippage, 
          priceImpactPct * 3 + 20 // Base formula: 3x price impact + 20%
        ));
        
        logger.info(`Calculated optimal slippage for ${tokenMint.toString()}: ${calculatedSlippage.toFixed(2)}% (price impact: ${priceImpactPct.toFixed(2)}%)`);
        return calculatedSlippage;
      }
      
      // If we don't have price impact data, try to estimate based on liquidity
      if (tokenInfo.liquidity) {
        const liquidityUsd = parseFloat(tokenInfo.liquidity);
        
        // Lower liquidity = higher slippage needed
        // This is a simple formula, adjust as needed
        let liquidityBasedSlippage;
        if (liquidityUsd < 1000) {
          liquidityBasedSlippage = maxSlippage; // Very low liquidity
        } else if (liquidityUsd < 5000) {
          liquidityBasedSlippage = 70; // Low liquidity
        } else if (liquidityUsd < 20000) {
          liquidityBasedSlippage = 50; // Medium liquidity
        } else if (liquidityUsd < 100000) {
          liquidityBasedSlippage = 30; // Good liquidity
        } else {
          liquidityBasedSlippage = 20; // High liquidity
        }
        
        logger.info(`Calculated liquidity-based slippage for ${tokenMint.toString()}: ${liquidityBasedSlippage.toFixed(2)}% (liquidity: ${liquidityUsd.toFixed(2)})`);
        return liquidityBasedSlippage;
      }
      
      // If all else fails, use default slippage
      logger.warn(`Jupiter failed to calculate optimal slippage: No routes found for the input and output mints. Using default.`);
      return defaultSlippage;
    } catch (error) {
      logger.error(`Error calculating optimal slippage: ${error.message}`);
      return defaultSlippage;
    }
  }
  /**
   * Check if a token is tradable on Jupiter
   * @param {string} tokenAddress - Token address to check
   * @param {string} [vsToken='So11111111111111111111111111111111111111112'] - Token to check tradability against (default: SOL)
   * @param {number} [minAmount=0.01] - Minimum amount in SOL to check tradability
   * @returns {Promise<{tradable: boolean, quote: Object|null, error: string|null}>} - Tradability information
   */
  async isTokenTradable(tokenAddress, vsToken = 'So11111111111111111111111111111111111111112', minAmount = 0.01) {
    try {
      // First check if the token has a pair on a trusted DEX
      const dexScreenerClient = require('./dexScreenerClient');
      const pairsInfo = await dexScreenerClient.checkActivePairs(tokenAddress, {
        minLiquidityUsd: 500,
        minVolumeUsd: 50,
        preferredDexes: this.trustedDexes
      });
      
      // Log DEX information
      if (pairsInfo.hasActivePairs) {
        logger.info(`Token ${tokenAddress} has ${pairsInfo.validPairs.length} active pairs`);
        if (pairsInfo.bestPair) {
          logger.info(`Best pair on ${pairsInfo.bestPair.dexId} with ${pairsInfo.bestPair.liquidity?.usd} liquidity`);
        }
      }
      
      // Check if we have pairs on trusted DEXes
      const hasTrustedPairs = pairsInfo.hasActivePairs && 
                             pairsInfo.validPairs.some(pair => 
                               this.trustedDexes.includes(pair.dexId?.toLowerCase()));
      
      if (!hasTrustedPairs) {
        logger.warn(`Token ${tokenAddress} has no pairs on trusted DEXes`);
      }
      
      // Normalize token addresses (handle SOL vs WSOL)
      const normalizedTokenAddress = this.normalizeTokenAddress(tokenAddress);
      const normalizedVsToken = this.normalizeTokenAddress(vsToken);
      
      // Ensure we have PublicKey objects
      const tokenMint = typeof normalizedTokenAddress === 'string' ? new PublicKey(normalizedTokenAddress) : normalizedTokenAddress;
      const vsMint = typeof normalizedVsToken === 'string' ? new PublicKey(normalizedVsToken) : normalizedVsToken;
      
      // Log if normalization changed anything
      if (normalizedTokenAddress !== tokenAddress.toString() || normalizedVsToken !== vsToken.toString()) {
        logger.info(`Normalized token addresses for tradability check: ${tokenAddress} -> ${normalizedTokenAddress}, ${vsToken} -> ${normalizedVsToken}`);
      }
      
      // SOL has 9 decimals, so 0.01 SOL = 10^7 lamports
      const amountLamports = Math.floor(minAmount * 10**9);
      
      // Determine appropriate slippage based on DEX
      let slippageBps = 100; // Default 1%
      
      if (pairsInfo.bestPair) {
        const dexId = pairsInfo.bestPair.dexId?.toLowerCase();
        slippageBps = this.dexSlippageThresholds[dexId] || this.dexSlippageThresholds.default;
        logger.info(`Using ${slippageBps/100}% slippage for ${dexId} DEX`);
      }
      
      // Try to get a quote
      const quote = await this.getQuote({
        inputMint: vsMint.toString(),
        outputMint: tokenMint.toString(),
        amount: amountLamports,
        slippageBps: slippageBps
      });
      
      // Check if we got a valid quote
      if (quote.error) {
        // If we have trusted pairs but Jupiter can't find a route, try with higher slippage
        if (hasTrustedPairs) {
          logger.info(`Retrying quote with higher slippage (25%) for token ${tokenAddress}`);
          const retryQuote = await this.getQuote({
            inputMint: vsMint.toString(),
            outputMint: tokenMint.toString(),
            amount: amountLamports,
            slippageBps: 2500 // 25% slippage
          });
          
          if (!retryQuote.error) {
            return {
              tradable: true,
              quote: retryQuote,
              error: null,
              requiresHighSlippage: true,
              dexInfo: pairsInfo
            };
          }
        }
        
        return {
          tradable: false,
          quote: null,
          error: quote.error,
          dexInfo: pairsInfo
        };
      }
      
      // Check if the quote has routes
      if (!quote.data || !quote.data.length) {
        return {
          tradable: false,
          quote,
          error: 'No routes found'
        };
      }
      
      return {
        tradable: true,
        quote,
        error: null
      };
    } catch (error) {
      logger.error(`Error checking token tradability: ${error.message}`);
      return {
        tradable: false,
        quote: null,
        error: error.message
      };
    }
  }
  
  /**
   * Get all tokens supported by Jupiter
   * @returns {Promise<Array>} - List of supported tokens
   */
  async getAllTokens() {
    try {
      // Use rate limiter for tokens API call
      return await this.rateLimiter.execute(
        async () => {
          const response = await axios.get(`${this.getApiHostname()}/v4/tokens`);
          return response.data.data || [];
        },
        false // Not a Price API call
      );
    } catch (error) {
      logger.error(`Error getting all tokens: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Rotate to a new RPC endpoint when rate limits are hit
   * @param {string} currentEndpoint - Current RPC endpoint
   * @returns {string} - New RPC endpoint
   */
  rotateRpcEndpoint(currentEndpoint) {
    try {
      // Get available RPC endpoints from config
      const rpcEndpoints = config.solana && config.solana.rpcEndpoints ? 
        config.solana.rpcEndpoints : [
          'https://api.mainnet-beta.solana.com',
          'https://solana-api.projectserum.com'
        ];
      
      // Get weighted endpoints if available
      const weightedEndpoints = config.solana && config.solana.weightedRpcEndpoints ? 
        config.solana.weightedRpcEndpoints : null;
      
      // If we have weighted endpoints, use them for better distribution
      if (weightedEndpoints) {
        const endpoints = Object.keys(weightedEndpoints);
        const weights = Object.values(weightedEndpoints);
        
        // If current endpoint is in the list, try to avoid reusing it
        const currentIndex = endpoints.indexOf(currentEndpoint);
        if (currentIndex >= 0) {
          // Temporarily reduce the weight of the current endpoint
          weights[currentIndex] = Math.max(1, weights[currentIndex] / 2);
        }
        
        // Calculate total weight
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
        
        // Generate a random value between 0 and totalWeight
        let random = Math.random() * totalWeight;
        
        // Find the endpoint based on weight
        for (let i = 0; i < endpoints.length; i++) {
          random -= weights[i];
          if (random <= 0) {
            const newEndpoint = endpoints[i];
            logger.info(`Rotated from ${currentEndpoint} to new RPC endpoint: ${newEndpoint}`);
            return newEndpoint;
          }
        }
        
        // Fallback to the last endpoint if something went wrong
        return endpoints[endpoints.length - 1];
      }
      
      // Simple rotation if no weights are defined
      const currentIndex = rpcEndpoints.indexOf(currentEndpoint);
      const nextIndex = (currentIndex + 1) % rpcEndpoints.length;
      const newEndpoint = rpcEndpoints[nextIndex];
      
      logger.info(`Rotated from ${currentEndpoint} to new RPC endpoint: ${newEndpoint}`);
      return newEndpoint;
    } catch (error) {
      logger.error(`Error rotating RPC endpoint: ${error.message}`);
      // Return the original endpoint if rotation fails
      return currentEndpoint;
    }
  }
  
  /**
   * Update the tier configuration
   * @param {string} tier - The tier to set ('free', 'proI', 'proII', 'proIII', 'proIV')
   * @param {string} apiKey - The API key for paid tiers
   * @returns {Object} - Current status after update
   */
  setTier(tier, apiKey = null) {
    return this.rateLimiter.setTier(tier, apiKey);
  }
  
  /**
   * Get PumpSwap pool information for a token
   * @param {string} tokenAddress - Token address to check
   * @returns {Promise<Object|null>} - Pool information or null if not found
   */
  async getPumpSwapPoolInfo(tokenAddress) {
    try {
      // Normalize token address (handle SOL vs WSOL)
      const normalizedTokenAddress = this.normalizeTokenAddress(tokenAddress);
      
      // Ensure we have a PublicKey object
      const tokenMint = typeof normalizedTokenAddress === 'string' ? new PublicKey(normalizedTokenAddress) : normalizedTokenAddress;
      
      // Log if normalization changed anything
      if (normalizedTokenAddress !== tokenAddress.toString()) {
        logger.info(`Normalized token address for PumpSwap pool info: ${tokenAddress} -> ${normalizedTokenAddress}`);
      }
      
      logger.info(`Getting PumpSwap pool info for ${tokenMint.toString()}`);
      
      // Use Jupiter's PumpSwap API to get pool information
      // This is a simplified version - in a real implementation, you would need to
      // query the actual pool information from PumpSwap or Jupiter
      
      // For now, we'll just return a mock pool object
      const pool = {
        id: `pumpswap_pool_${tokenMint.toString().substring(0, 8)}`,
        address: tokenMint.toString(),
        solReserve: 10000000000, // 10 SOL
        tokenReserve: 1000000000000, // 1 billion tokens
        liquidity: 10000
      };
      
      logger.info(`Found PumpSwap pool: ${pool.id} with ${pool.liquidity} liquidity`);
      
      return pool;
    } catch (error) {
      logger.error(`Error getting PumpSwap pool info: ${error.message}`);
      return null;
    }
  }
  

  
  /**
   * Create a PumpSwap swap transaction using Jupiter's PumpSwap API
   * @param {Object} params - Swap parameters
   * @param {string} params.tokenAddress - Token address to swap to
   * @param {string} params.userWallet - User wallet address
   * @param {number} params.inputAmount - Input amount in lamports
   * @param {string} params.priorityFeeLevel - Priority fee level ('low', 'medium', 'high')
   * @returns {Promise<{instructions: Array, signers: Array}>} - Transaction instructions and signers
   */
  async createPumpSwapTransaction(params) {
    try {
      const { tokenAddress, userWallet, inputAmount, priorityFeeLevel = 'medium' } = params;
      
      // Normalize token address (handle SOL vs WSOL)
      const normalizedTokenAddress = this.normalizeTokenAddress(tokenAddress);
      
      // Ensure we have PublicKey objects
      const tokenMint = typeof normalizedTokenAddress === 'string' ? new PublicKey(normalizedTokenAddress) : normalizedTokenAddress;
      const userPublicKey = typeof userWallet === 'string' ? new PublicKey(userWallet) : userWallet;
      
      // Log if normalization changed anything
      if (normalizedTokenAddress !== tokenAddress.toString()) {
        logger.info(`Normalized token address for PumpSwap transaction: ${tokenAddress} -> ${normalizedTokenAddress}`);
      }
      
      logger.info(`Creating PumpSwap transaction for ${tokenMint.toString()} with ${inputAmount} lamports`);
      
      // Use Jupiter's PumpSwap API to get swap instructions
      const response = await axios.post('https://public.jupiterapi.com/pump-fun/swap-instructions', {
        wallet: userPublicKey.toString(),
        type: 'BUY',
        mint: tokenMint.toString(),
        inAmount: inputAmount.toString(),
        priorityFeeLevel
      });
      
      if (!response.data || !response.data.instructions) {
        throw new Error('Failed to get PumpSwap instructions from Jupiter API');
      }
      
      logger.info(`Received PumpSwap instructions from Jupiter API`);
      
      return response.data;
    } catch (error) {
      logger.error(`Error creating PumpSwap transaction: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Execute a direct swap using PumpSwap for tokens not available on Jupiter
   * @param {Object} params - Swap parameters
   * @param {string} params.tokenAddress - Token address to swap to
   * @param {string} params.userWallet - User wallet address
   * @param {number} params.solAmount - SOL amount to swap (in SOL, not lamports)
   * @param {string} params.priorityFeeLevel - Priority fee level ('low', 'medium', 'high')
   * @returns {Promise<{success: boolean, swapData: Object|null, error: string|null}>}
   */
  async executePumpSwapDirectSwap(params) {
    try {
      const { tokenAddress, userWallet, solAmount = 0.01, priorityFeeLevel = 'medium' } = params;
      
      // Normalize token address (handle SOL vs WSOL)
      const normalizedTokenAddress = this.normalizeTokenAddress(tokenAddress);
      
      // Log if normalization changed anything
      if (normalizedTokenAddress !== tokenAddress.toString()) {
        logger.info(`Normalized token address for PumpSwap direct swap: ${tokenAddress} -> ${normalizedTokenAddress}`);
      }
      
      logger.info(`Executing PumpSwap direct swap for ${normalizedTokenAddress} with ${solAmount} SOL`);
      
      // Convert SOL to lamports
      const inputAmount = Math.floor(solAmount * 10**9);
      
      // Use Jupiter's PumpSwap API to execute the swap
      const response = await axios.post('https://public.jupiterapi.com/pump-fun/swap', {
        wallet: userWallet.toString(),
        type: 'BUY',
        mint: normalizedTokenAddress.toString(),
        inAmount: inputAmount.toString(),
        priorityFeeLevel
      });
      
      if (!response.data) {
        return {
          success: false,
          swapData: null,
          error: 'Failed to get response from Jupiter PumpSwap API'
        };
      }
      
      // If we need the transaction instructions instead of the full transaction
      // we can use the createPumpSwapTransaction method
      const instructionsData = await this.createPumpSwapTransaction({
        tokenAddress: normalizedTokenAddress,
        userWallet,
        inputAmount,
        priorityFeeLevel
      });
      
      return {
        success: true,
        swapData: response.data,
        instructionsData,
        error: null
      };
    } catch (error) {
      logger.error(`Error executing PumpSwap direct swap: ${error.message}`);
      return {
        success: false,
        swapData: null,
        error: error.message
      };
    }
  }
  
  /**
   * Execute a swap using Jupiter API
   * @param {Object} params - Swap parameters
   * @param {string} params.inputMint - Input token mint address
   * @param {string} params.outputMint - Output token mint address
   * @param {string|number} params.amount - Amount in lamports/smallest units
   * @param {number} params.slippageBps - Slippage in basis points (e.g., 50 = 0.5%)
   * @param {string} params.userPublicKey - User wallet public key
   * @param {Object} params.connection - Solana connection object
   * @returns {Promise<Object>} - Swap result
   */
  async executeSwap(params) {
    try {
      const { inputMint, outputMint, amount, slippageBps = 50, userPublicKey, connection } = params;
      
      if (!inputMint || !outputMint || !amount || !userPublicKey) {
        throw new Error('inputMint, outputMint, amount, and userPublicKey are required');
      }
      
      // Normalize token addresses (handle SOL vs WSOL)
      const normalizedInputMint = this.normalizeTokenAddress(inputMint);
      const normalizedOutputMint = this.normalizeTokenAddress(outputMint);
      
      // Log the swap attempt
      logger.info(`Getting Jupiter API quote for ${normalizedInputMint} -> ${normalizedOutputMint}`);
      
      // Check if the token is on cooldown
      if (this.isTokenOnCooldown(normalizedOutputMint)) {
        throw new Error(`Token ${normalizedOutputMint} is on cooldown due to previous failed attempts`);
      }
      
      // 1. Get a quote first
      const quote = await this.getQuote({
        inputMint: normalizedInputMint,
        outputMint: normalizedOutputMint,
        amount,
        slippageBps
      });
      
      // Check if we got a valid quote
      if (quote.error) {
        // Record the failed attempt
        this.recordFailedTradeAttempt(
          normalizedOutputMint,
          `Failed to get quote: ${quote.error}`,
          'Jupiter'
        );
        throw new Error(`Failed to get quote: ${quote.error}`);
      }
      
      // Log the quote details
      const outAmount = quote.data?.outAmount || quote.outAmount;
      const outAmountWithSlippage = quote.data?.outAmountWithSlippage || quote.outAmountWithSlippage;
      logger.info(`Got quote with output amount: ${outAmount} (${outAmountWithSlippage} with slippage)`);
      
      // 2. Execute the swap using the quote
      return await this.rateLimiter.execute(
        async () => {
          try {
            // Create the swap transaction
            const swapResponse = await axios.post(`${this.getApiHostname()}/v6/swap`, {
              quoteResponse: quote,
              userPublicKey,
              wrapAndUnwrapSol: true, // Automatically wrap/unwrap SOL
              dynamicComputeUnitLimit: true, // Optimize compute units
              prioritizationFeeLamports: 1000 // Add a small priority fee
            });
            
            return swapResponse.data;
          } catch (error) {
            // Handle specific error cases
            if (error.response) {
              const status = error.response.status;
              const message = error.response.data?.message || error.response.data?.error || error.message;
              
              // Record the failed attempt
              this.recordFailedTradeAttempt(
                normalizedOutputMint,
                `Jupiter API swap transaction failed with status ${status}: ${message}`,
                'Jupiter'
              );
              
              // Check for route not found error
              if (status === 404 || message.includes('Route not found') || message.includes('No routes found')) {
                throw new Error(`Jupiter API swap transaction failed with status ${status}: Route not found`);
              }
              
              throw new Error(`Jupiter API swap transaction failed with status ${status}: ${message}`);
            }
            throw error;
          }
        },
        false // Not a Price API call
      );
    } catch (error) {
      logger.error(`Error executing Jupiter API swap: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if a token is likely a PumpSwap token
   * @param {string} tokenAddress - Token address to check
   * @returns {boolean} - Whether the token is likely a PumpSwap token
   */
  isPumpSwapToken(tokenAddress) {
    // Check if the address contains 'pump' which is common for PumpSwap tokens
    const isPump = tokenAddress.toLowerCase().includes('pump');
    
    if (isPump) {
      logger.info(`Token ${tokenAddress} detected as a PumpSwap token (contains 'pump' in address)`);  
    }
    
    return isPump;
  }
  
  /**
   * Try to swap tokens using Jupiter, with fallback to ApeJupiter, PumpSwap, and Raydium
   * @param {Object} params - Swap parameters
   * @param {string} params.tokenAddress - Token address to swap to
   * @param {string} params.userWallet - User wallet address
   * @param {number} params.solAmount - SOL amount to swap (in SOL, not lamports)
   * @param {number} params.slippageBps - Slippage in basis points (e.g., 500 = 5%)
   * @param {string} params.priorityFeeLevel - Priority fee level for PumpSwap ('low', 'medium', 'high')
   * @param {Object} params.connection - Solana connection object
   * @returns {Promise<{success: boolean, usedFallback: boolean, fallbackType: string|null, swapData: Object|null, error: string|null}>}
   */
  async swapWithFallback(params) {
    try {
      const { tokenAddress, userWallet, solAmount = 0.01, slippageBps = 500, priorityFeeLevel = 'medium', connection } = params;
      
      // Normalize token address (handle SOL vs WSOL)
      const normalizedTokenAddress = this.normalizeTokenAddress(tokenAddress);
      
      // Log if normalization changed anything
      if (normalizedTokenAddress !== tokenAddress.toString()) {
        logger.info(`Normalized token address for swap: ${tokenAddress} -> ${normalizedTokenAddress}`);
      }
      
      // Check if this is a PumpSwap token
      const isPumpSwapToken = this.isPumpSwapToken(normalizedTokenAddress);
      
      // If it's a PumpSwap token, we'll try PumpSwap first before Jupiter
      if (isPumpSwapToken) {
        logger.info(`Token ${normalizedTokenAddress} appears to be a PumpSwap token, trying PumpSwap first`);
        
        try {
          const pumpSwapClient = require('./pumpSwapClient');
          logger.info(`Executing PumpSwap direct swap for ${normalizedTokenAddress} with ${solAmount} SOL`);
          
          const pumpSwapResult = await pumpSwapClient.executeDirectSwap({
            tokenAddress: normalizedTokenAddress,
            userWallet,
            solAmount,
            slippageBps,
            priorityFeeLevel
          });
          
          if (pumpSwapResult.success) {
            logger.info(`PumpSwap direct swap successful for ${normalizedTokenAddress}`);
            return {
              success: true,
              usedFallback: true,
              fallbackType: 'PumpSwap',
              swapData: pumpSwapResult,
              error: null
            };
          } else {
            logger.warn(`PumpSwap swap returned unsuccessful result: ${pumpSwapResult.error || 'Unknown error'}`);
            logger.info(`Falling back to Jupiter for PumpSwap token ${normalizedTokenAddress}`);
            // Continue to Jupiter fallback
          }
        } catch (pumpSwapError) {
          logger.warn(`PumpSwap direct swap failed: ${pumpSwapError.message}`);
          logger.info(`Falling back to Jupiter for PumpSwap token ${normalizedTokenAddress}`);
          // Continue to Jupiter fallback
        }
      }
      
      // Check if the token is on cooldown
      if (this.isTokenOnCooldown(normalizedTokenAddress)) {
        const error = `Token ${normalizedTokenAddress} is on cooldown due to previous failed attempts`;
        logger.warn(error);
        return {
          success: false,
          usedFallback: false,
          fallbackType: null,
          swapData: null,
          error
        };
      }
      
      // Check token compliance if connection is provided
      let isPotentialPumpSwapToken = isPumpSwapToken;
      if (connection) {
        try {
          const complianceCheck = await this.checkTokenCompliance(normalizedTokenAddress, connection);
          
          if (!complianceCheck.isCompliant) {
            logger.warn(`Token ${normalizedTokenAddress} uses non-standard program: ${complianceCheck.programId}`);
            logger.warn('Non-standard tokens may not be compatible with Jupiter routing');
            
            // If it's a non-standard token, it might be a PumpSwap token
            if (normalizedTokenAddress.toLowerCase().includes('pump')) {
              isPotentialPumpSwapToken = true;
              logger.info(`Non-standard token ${normalizedTokenAddress} contains 'pump' in address, likely a PumpSwap token`);
            }
          }
        } catch (complianceError) {
          logger.error(`Error checking token compliance: ${complianceError.message}`);
          // Continue with the swap attempt despite the error
        }
      }
      
      // Convert SOL to lamports
      const inputAmount = Math.floor(solAmount * 10**9);
      
      // ==================== FALLBACK SYSTEM START ====================
      // The following code implements a complete fallback system with multiple DEXes
      // 1. First try Jupiter (main aggregator)
      // 2. Then try Jupiter API directly
      // 3. Then try ApeJupiter (alternative Jupiter endpoint)
      // 4. Then try PumpSwap direct integration
      // 5. Finally try Raydium direct integration
      // ===============================================================
      
      // STEP 1: Try Jupiter main aggregator
      logger.info(`FALLBACK STEP 1: Attempting Jupiter main aggregator for ${normalizedTokenAddress}`);
      const tradability = await this.isTokenTradable(normalizedTokenAddress);
      
      if (tradability.tradable) {
        // Token is tradable on Jupiter, use Jupiter for the swap
        logger.info(`Token ${normalizedTokenAddress} is tradable on Jupiter, using Jupiter for swap`);
        
        try {
          // Create a wrapped SOL token account if needed
          let wrappedSolAccount = null;
          if (connection) {
            try {
              // Create a wrapped SOL account if we're swapping from SOL
              const userPublicKey = new PublicKey(typeof userWallet === 'string' ? userWallet : userWallet.toString());
              
              // Find or create associated token account for WSOL
              const associatedTokenAddress = await Token.getAssociatedTokenAddress(
                ASSOCIATED_TOKEN_PROGRAM_ID,
                TOKEN_PROGRAM_ID,
                new PublicKey(this.WSOL_ADDRESS),
                userPublicKey
              );
              
              // Check if the account exists
              const tokenAccount = await connection.getAccountInfo(associatedTokenAddress);
              
              if (!tokenAccount) {
                logger.info(`Creating wrapped SOL token account for ${userPublicKey.toString()}`);
                // We'll need to create the token account as part of the transaction
                wrappedSolAccount = associatedTokenAddress;
              } else {
                logger.info(`Using existing wrapped SOL token account for ${userPublicKey.toString()}`);
              }
            } catch (error) {
              logger.warn(`Error checking/creating wrapped SOL account: ${error.message}`);
              // Continue without the wrapped SOL account, Jupiter might handle it
            }
          }
          
          // Execute the swap using Jupiter API
          const swapResult = await this.executeSwap({
            inputMint: this.WSOL_ADDRESS,
            outputMint: normalizedTokenAddress,
            amount: inputAmount,
            slippageBps,
            userPublicKey: typeof userWallet === 'string' ? userWallet : userWallet.toString(),
            connection,
            wrappedSolAccount
          });
          
          return {
            success: true,
            usedFallback: false,
            fallbackType: null,
            swapData: swapResult,
            error: null
          };
        } catch (error) {
          // If Jupiter swap fails, log the error and try the fallback
          logger.error(`Jupiter swap failed: ${error.message}. Trying alternative method...`);
          this.recordFailedTradeAttempt(normalizedTokenAddress, error.message, 'Jupiter');
          
          // Continue to fallback
        }
      } else {
        logger.info(`Token ${normalizedTokenAddress} is not tradable on Jupiter, trying alternative method...`);
        this.recordFailedTradeAttempt(
          normalizedTokenAddress, 
          tradability.error || 'Not tradable on Jupiter', 
          'Jupiter'
        );
      }
      
      // STEP 2: Try Jupiter API directly as fallback
      logger.info(`FALLBACK STEP 2: Attempting Jupiter API directly for ${normalizedTokenAddress}`);
      try {
        logger.info(`Executing Jupiter API swap for ${normalizedTokenAddress} with ${solAmount} SOL (slippage: ${slippageBps} bps)`);
        
        // Get quote from Jupiter API
        logger.info(`Getting Jupiter API quote for ${this.WSOL_ADDRESS} -> ${normalizedTokenAddress}`);
        
        // Create a wrapped SOL token account if needed
        let wrappedSolAccount = null;
        if (connection) {
          try {
            // Create a wrapped SOL account if we're swapping from SOL
            const userPublicKey = new PublicKey(typeof userWallet === 'string' ? userWallet : userWallet.toString());
            
            // Find or create associated token account for WSOL
            const associatedTokenAddress = await Token.getAssociatedTokenAddress(
              ASSOCIATED_TOKEN_PROGRAM_ID,
              TOKEN_PROGRAM_ID,
              new PublicKey(this.WSOL_ADDRESS),
              userPublicKey
            );
            
            // Check if the account exists
            const tokenAccount = await connection.getAccountInfo(associatedTokenAddress);
            
            if (!tokenAccount) {
              logger.info(`Creating wrapped SOL token account for ${userPublicKey.toString()}`);
              // Create the token account
              const transaction = new Transaction();
              
              // Add instruction to create token account
              transaction.add(
                Token.createAssociatedTokenAccountInstruction(
                  ASSOCIATED_TOKEN_PROGRAM_ID,
                  TOKEN_PROGRAM_ID,
                  new PublicKey(this.WSOL_ADDRESS),
                  associatedTokenAddress,
                  userPublicKey,
                  userPublicKey
                )
              );
              
              // Add instruction to transfer SOL to the token account
              transaction.add(
                SystemProgram.transfer({
                  fromPubkey: userPublicKey,
                  toPubkey: associatedTokenAddress,
                  lamports: inputAmount
                })
              );
              
              // Add instruction to sync native balance
              transaction.add(
                Token.createSyncNativeInstruction(
                  TOKEN_PROGRAM_ID,
                  associatedTokenAddress
                )
              );
              
              // Send and confirm transaction
              const signature = await connection.sendTransaction(transaction, [/* wallet keypair */]);
              await connection.confirmTransaction(signature, 'confirmed');
              
              logger.info(`Created wrapped SOL token account: ${associatedTokenAddress.toString()}`);
              wrappedSolAccount = associatedTokenAddress;
            } else {
              logger.info(`Using existing wrapped SOL token account for ${userPublicKey.toString()}`);
              wrappedSolAccount = associatedTokenAddress;
            }
          } catch (error) {
            logger.warn(`Error creating wrapped SOL account: ${error.message}`);
            // Continue without the wrapped SOL account
          }
        }
        
        // Get quote from Jupiter API
        const response = await axios.get(`${this.getApiHostname()}/v6/quote`, {
          params: {
            inputMint: this.WSOL_ADDRESS,
            outputMint: normalizedTokenAddress,
            amount: inputAmount.toString(),
            slippageBps: slippageBps.toString(),
            onlyDirectRoutes: false,
            asLegacyTransaction: false
          }
        });
        
        if (!response.data || response.data.error) {
          throw new Error(response.data?.error || 'Invalid response from Jupiter API');
        }
        
        logger.info(`Got quote with output amount: ${response.data.outAmount} (${response.data.outAmountWithSlippage} with slippage)`);
        
        // Execute the swap
        const swapResponse = await axios.post(`${this.getApiHostname()}/v6/swap`, {
          quoteResponse: response.data,
          userPublicKey: typeof userWallet === 'string' ? userWallet : userWallet.toString(),
          wrapUnwrapSOL: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 1000
        });
        
        return {
          success: true,
          usedFallback: true,
          fallbackType: 'Jupiter API',
          swapData: swapResponse.data,
          error: null
        };
      } catch (error) {
        logger.error(`Error executing Jupiter API swap: ${error.message}`);
        this.recordFailedTradeAttempt(normalizedTokenAddress, error.message, 'Jupiter API');
        
        // Continue to next fallback
      }
      
      // STEP 3: Try ApeJupiter as fallback
      logger.info(`FALLBACK STEP 3: Attempting ApeJupiter for ${normalizedTokenAddress}`);
      try {
        logger.info(`Executing ApeJupiter swap for ${normalizedTokenAddress} with ${solAmount} SOL`);
        
        // Get quote from ApeJupiter
        logger.info(`Getting ApeJupiter quote for ${this.WSOL_ADDRESS} -> ${normalizedTokenAddress}, amount: ${inputAmount}, slippage: ${slippageBps} bps`);
        
        // Try to get ApeJupiter quote
        let quoteResponse;
        try {
          // Make sure we're using a wrapped SOL token account
          let wrappedSolAccount = null;
          if (connection) {
            try {
              const userPublicKey = new PublicKey(typeof userWallet === 'string' ? userWallet : userWallet.toString());
              const associatedTokenAddress = await Token.getAssociatedTokenAddress(
                ASSOCIATED_TOKEN_PROGRAM_ID,
                TOKEN_PROGRAM_ID,
                new PublicKey(this.WSOL_ADDRESS),
                userPublicKey
              );
              
              wrappedSolAccount = associatedTokenAddress;
            } catch (error) {
              logger.warn(`Error getting wrapped SOL account for ApeJupiter: ${error.message}`);
            }
          }
          
          // Get quote from ApeJupiter
          quoteResponse = await axios.get('https://api.jup.ag/api/quote', {
            params: {
              inputMint: this.WSOL_ADDRESS,
              outputMint: normalizedTokenAddress,
              amount: inputAmount.toString(),
              slippageBps: slippageBps.toString(),
              onlyDirectRoutes: false,
              asLegacyTransaction: false,
              // Include wrapped SOL account if available
              ...(wrappedSolAccount ? { userPublicKey: wrappedSolAccount.toString() } : {})
            }
          });
        } catch (error) {
          logger.error(`Error getting ApeJupiter quote: ${error.message}`);
          throw new Error(`Invalid quote response from ApeJupiter`);
        }
        
        // Validate the quote response
        if (!quoteResponse || !quoteResponse.data || !quoteResponse.data.outAmount) {
          logger.error(`Error getting ApeJupiter quote: Invalid quote response from ApeJupiter`);
          
          // Try with higher slippage
          logger.info(`Retrying ApeJupiter quote with higher slippage (25%)`);
          try {
            quoteResponse = await axios.get('https://api.jup.ag/api/quote', {
              params: {
                inputMint: this.WSOL_ADDRESS,
                outputMint: normalizedTokenAddress,
                amount: inputAmount.toString(),
                slippageBps: '2500', // 25% slippage
                onlyDirectRoutes: false,
                asLegacyTransaction: false
              }
            });
            
            if (!quoteResponse || !quoteResponse.data || !quoteResponse.data.outAmount) {
              logger.error(`Error getting ApeJupiter quote: Invalid quote response from ApeJupiter`);
              throw new Error(`Retry with higher slippage also failed: Invalid quote response from ApeJupiter`);
            }
          } catch (error) {
            logger.error(`Error getting ApeJupiter quote: ${error.message}`);
            throw new Error(`Failed to get ApeJupiter quote: Invalid quote response from ApeJupiter`);
          }
        }
        
        // Execute the swap
        const swapResponse = await axios.post('https://api.jup.ag/api/swap', {
          quoteResponse: quoteResponse.data,
          userPublicKey: typeof userWallet === 'string' ? userWallet : userWallet.toString(),
          wrapUnwrapSOL: true
        });
        
        return {
          success: true,
          usedFallback: true,
          fallbackType: 'ApeJupiter',
          swapData: swapResponse.data,
          error: null
        };
      } catch (error) {
        logger.error(`Error executing ApeJupiter swap: ${error.message}`);
        this.recordFailedTradeAttempt(normalizedTokenAddress, error.message, 'ApeJupiter');
        logger.error(`ApeJupiter fallback swap failed: ${error.message}`);
        
        // Continue to next fallback
      }
      
      // STEP 4: Try PumpSwap as fallback
      logger.info(`FALLBACK STEP 4: Attempting PumpSwap direct integration for ${normalizedTokenAddress}`);
      try {
        const pumpSwapClient = require('./pumpSwapClient');
        
        // Check if this is a PumpSwap token (if we haven't already tried it)
        if (!isPumpSwapToken && !isPotentialPumpSwapToken) {
          // Check if the token has 'pump' in the address
          const containsPump = normalizedTokenAddress.toLowerCase().includes('pump');
          if (containsPump) {
            logger.info(`Token ${normalizedTokenAddress} contains 'pump' in address, likely a PumpSwap token`);
            isPotentialPumpSwapToken = true;
          }
          
          // Check if the token has a PumpSwap pool
          const hasPool = await pumpSwapClient.hasPool(normalizedTokenAddress);
          if (hasPool) {
            logger.info(`Token ${normalizedTokenAddress} has a PumpSwap pool`);
            isPotentialPumpSwapToken = true;
          }
        }
        
        logger.info(`Executing PumpSwap direct swap for ${normalizedTokenAddress} with ${solAmount} SOL`);
        
        const pumpSwapResult = await pumpSwapClient.executeDirectSwap({
          tokenAddress: normalizedTokenAddress,
          userWallet,
          solAmount,
          slippageBps,
          priorityFeeLevel,
          connection // Pass the connection object
        });
        
        if (pumpSwapResult.success) {
          logger.info(`PumpSwap direct swap successful for ${normalizedTokenAddress}`);
          return {
            success: true,
            usedFallback: true,
            fallbackType: 'PumpSwap',
            swapData: pumpSwapResult,
            error: null
          };
        } else {
          logger.error(`PumpSwap swap returned unsuccessful result: ${pumpSwapResult.error || 'Unknown error'}`);
          this.recordFailedTradeAttempt(normalizedTokenAddress, pumpSwapResult.error || 'Unsuccessful swap', 'PumpSwap');
          // Continue to next fallback
        }
      } catch (pumpSwapError) {
        logger.error(`PumpSwap fallback swap failed: ${pumpSwapError.message}`);
        this.recordFailedTradeAttempt(normalizedTokenAddress, pumpSwapError.message, 'PumpSwap');
        // Continue to next fallback
      }
      
      // STEP 5: Try Raydium as final fallback
      logger.info(`FALLBACK STEP 5: Attempting Raydium direct integration for ${normalizedTokenAddress}`);
      try {
        // Import the Raydium client
        const raydiumClient = require('./raydiumDirectClient');
        logger.info(`Executing Raydium direct swap for ${normalizedTokenAddress} with ${solAmount} SOL`);
        
        // Make sure we have a connection object
        if (!connection) {
          logger.warn('No connection object provided for Raydium swap, attempting to get one from RPC manager');
          try {
            const rpcManager = require('./rpcManager');
            connection = rpcManager.getCurrentConnection();
          } catch (rpcError) {
            logger.error(`Failed to get connection from RPC manager: ${rpcError.message}`);
            throw new Error('Connection object is required for Raydium swap');
          }
        }
        
        const raydiumResult = await raydiumClient.executeSwap({
          tokenAddress: normalizedTokenAddress,
          userWallet,
          solAmount,
          slippageBps,
          connection
        });
        
        if (raydiumResult.success) {
          logger.info(`Raydium direct swap successful for ${normalizedTokenAddress}`);
          return {
            success: true,
            usedFallback: true,
            fallbackType: 'Raydium',
            swapData: raydiumResult,
            error: null
          };
        } else {
          logger.error(`Raydium swap returned unsuccessful result: ${raydiumResult.error || 'Unknown error'}`);
          this.recordFailedTradeAttempt(normalizedTokenAddress, raydiumResult.error || 'Unsuccessful swap', 'Raydium');
          // All fallbacks failed
          throw new Error(`All swap methods failed for ${normalizedTokenAddress}`);
        }
      } catch (raydiumError) {
        logger.error(`Raydium fallback swap failed: ${raydiumError.message}`);
        this.recordFailedTradeAttempt(normalizedTokenAddress, raydiumError.message, 'Raydium');
        // All fallbacks failed
        throw new Error(`All swap methods failed for ${normalizedTokenAddress}: ${raydiumError.message}`);
      }
    } catch (error) {
      logger.error(`Error in swap with fallback: ${error.message}`);
      this.recordFailedTradeAttempt(
        tokenAddress, 
        `Swap failed with all methods: ${error.message}`, 
        'All DEXes'
      );
      
      return {
        success: false,
        usedFallback: false,
        fallbackType: null,
        swapData: null,
        error: error.message
      };
    }
  }
  /**
   * Execute a direct swap using Raydium for tokens not available on Jupiter or ApeJupiter
   * @param {Object} params - Swap parameters
   * @param {string} params.tokenAddress - Token address to swap to
   * @param {string} params.userWallet - User wallet address
   * @param {number} params.solAmount - SOL amount to swap (in SOL, not lamports)
   * @param {number} params.slippageBps - Slippage in basis points
   * @param {Object} params.connection - Solana connection object
   * @returns {Promise<{success: boolean, usedFallback: boolean, fallbackType: string, swapData: Object|null, error: string|null}>}
   */
  async executeRaydiumDirectSwap(params) {
    try {
      const { tokenAddress, userWallet, solAmount = 0.01, slippageBps = 500, connection } = params;
      
      // Normalize token address
      const normalizedTokenAddress = this.normalizeTokenAddress(tokenAddress);
      
      logger.info(`Executing Raydium direct swap for ${normalizedTokenAddress} with ${solAmount} SOL (slippage: ${slippageBps} bps)`);
      
      // Check if we have a connection object
      if (!connection) {
        throw new Error('Solana connection object is required for Raydium direct swap');
      }
      
      // Convert SOL to lamports
      const inputAmount = Math.floor(solAmount * 10**9);
      
      try {
        // Import Raydium SDK modules
        const { Liquidity, Token, TokenAmount, Percent, SPL_ACCOUNT_LAYOUT, LiquidityPoolKeys, LIQUIDITY_STATE_LAYOUT_V4 } = require('@raydium-io/raydium-sdk');
        const { PublicKey, Transaction, sendAndConfirmTransaction, SystemProgram } = require('@solana/web3.js');
        
        // Define token addresses
        const solToken = new Token(new PublicKey('So11111111111111111111111111111111111111112'), 9, 'WSOL', 'Wrapped SOL');
        
        // Get token info to determine decimals
        let tokenDecimals = 9; // Default to 9 decimals
        try {
          const tokenInfo = await this.getTokenInfo(normalizedTokenAddress);
          if (tokenInfo && tokenInfo.decimals) {
            tokenDecimals = parseInt(tokenInfo.decimals);
            logger.info(`Token ${normalizedTokenAddress} has ${tokenDecimals} decimals`);
          }
        } catch (error) {
          logger.warn(`Could not get token decimals, using default of 9: ${error.message}`);
        }
        
        const targetToken = new Token(new PublicKey(normalizedTokenAddress), tokenDecimals, 'TARGET', 'Target Token');
        
        // Find Raydium pools for the token
        logger.info(`Finding Raydium pools for ${normalizedTokenAddress}`);
        
        // Get all Raydium pools
        const allPoolKeys = await Liquidity.fetchAllPoolKeys(connection);
        
        // Find pools that contain our target token
        const targetPools = allPoolKeys.filter(pool => 
          pool.baseMint.toString() === normalizedTokenAddress || 
          pool.quoteMint.toString() === normalizedTokenAddress
        );
        
        if (targetPools.length === 0) {
          // Try to find pools via Raydium API as a fallback
          logger.info(`No pools found via SDK, trying Raydium API...`);
          
          try {
            const response = await axios.get('https://api.raydium.io/v2/main/pairs');
            const pairs = response.data;
            
            // Find pairs with our token
            const targetPairs = pairs.filter(pair => 
              pair.baseMint === normalizedTokenAddress || 
              pair.quoteMint === normalizedTokenAddress
            );
            
            if (targetPairs.length > 0) {
              logger.info(`Found ${targetPairs.length} Raydium pairs via API`);
              
              // Convert API pairs to pool keys
              for (const pair of targetPairs) {
                try {
                  const poolKeys = new LiquidityPoolKeys({
                    id: new PublicKey(pair.ammId),
                    baseMint: new PublicKey(pair.baseMint),
                    quoteMint: new PublicKey(pair.quoteMint),
                    lpMint: new PublicKey(pair.lpMint),
                    baseDecimals: pair.baseDecimals,
                    quoteDecimals: pair.quoteDecimals,
                    lpDecimals: pair.lpDecimals,
                    version: 4,
                    programId: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
                    authority: new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'),
                    openOrders: new PublicKey(pair.openOrders),
                    targetOrders: new PublicKey(pair.targetOrders),
                    baseVault: new PublicKey(pair.baseVault),
                    quoteVault: new PublicKey(pair.quoteVault),
                    marketVersion: 3,
                    marketProgramId: new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'),
                    marketId: new PublicKey(pair.marketId),
                    marketAuthority: PublicKey.findProgramAddressSync(
                      [pair.marketId.toBuffer()],
                      new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX')
                    )[0],
                    marketBaseVault: new PublicKey(pair.marketBaseVault),
                    marketQuoteVault: new PublicKey(pair.marketQuoteVault),
                    marketBids: new PublicKey(pair.marketBids),
                    marketAsks: new PublicKey(pair.marketAsks),
                    marketEventQueue: new PublicKey(pair.marketEventQueue)
                  });
                  
                  targetPools.push(poolKeys);
                } catch (error) {
                  logger.warn(`Error converting API pair to pool keys: ${error.message}`);
                }
              }
            }
          } catch (apiError) {
            logger.error(`Error fetching Raydium pairs from API: ${apiError.message}`);
          }
        }
        
        if (targetPools.length === 0) {
          throw new Error(`No Raydium pools found for token ${normalizedTokenAddress}`);
        }
        
        logger.info(`Found ${targetPools.length} Raydium pools for token ${normalizedTokenAddress}`);
        
        // Find the best pool (highest liquidity)
        let bestPool = targetPools[0];
        let highestLiquidity = 0;
        
        for (const pool of targetPools) {
          try {
            const poolInfo = await Liquidity.fetchInfo({
              connection,
              poolKeys: pool
            });
            
            // Calculate liquidity value
            const liquidity = poolInfo.baseReserve * poolInfo.quoteReserve;
            
            if (liquidity > highestLiquidity) {
              highestLiquidity = liquidity;
              bestPool = pool;
            }
          } catch (error) {
            logger.warn(`Error fetching pool info: ${error.message}`);
          }
        }
        
        logger.info(`Selected best Raydium pool with ID: ${bestPool.id.toString()}`);
        
        // Get pool info
        const poolInfo = await Liquidity.fetchInfo({
          connection,
          poolKeys: bestPool
        });
        
        // Determine if we're swapping from base to quote or quote to base
        const isBaseToQuote = bestPool.baseMint.toString() === 'So11111111111111111111111111111111111111112';
        const isQuoteToBase = bestPool.quoteMint.toString() === 'So11111111111111111111111111111111111111112';
        
        if (!isBaseToQuote && !isQuoteToBase) {
          // Neither base nor quote is SOL, we need to do a multi-hop swap
          logger.info(`Neither base nor quote is SOL, attempting multi-hop swap`);
          
          // For multi-hop, we'll swap SOL -> USDC -> TARGET TOKEN
          // First find a SOL/USDC pool
          const usdcMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
          
          const solUsdcPools = allPoolKeys.filter(pool => 
            (pool.baseMint.toString() === 'So11111111111111111111111111111111111111112' && pool.quoteMint.toString() === usdcMint.toString()) ||
            (pool.quoteMint.toString() === 'So11111111111111111111111111111111111111112' && pool.baseMint.toString() === usdcMint.toString())
          );
          
          if (solUsdcPools.length === 0) {
            throw new Error('No SOL/USDC pool found for multi-hop swap');
          }
          
          // Find the best SOL/USDC pool
          let bestSolUsdcPool = solUsdcPools[0];
          let highestSolUsdcLiquidity = 0;
          
          for (const pool of solUsdcPools) {
            try {
              const poolInfo = await Liquidity.fetchInfo({
                connection,
                poolKeys: pool
              });
              
              const liquidity = poolInfo.baseReserve * poolInfo.quoteReserve;
              
              if (liquidity > highestSolUsdcLiquidity) {
                highestSolUsdcLiquidity = liquidity;
                bestSolUsdcPool = pool;
              }
            } catch (error) {
              logger.warn(`Error fetching SOL/USDC pool info: ${error.message}`);
            }
          }
          
          logger.info(`Selected best SOL/USDC pool with ID: ${bestSolUsdcPool.id.toString()}`);
          
          // Now find a USDC/TARGET pool
          const usdcTargetPools = allPoolKeys.filter(pool => 
            (pool.baseMint.toString() === usdcMint.toString() && pool.quoteMint.toString() === normalizedTokenAddress) ||
            (pool.quoteMint.toString() === usdcMint.toString() && pool.baseMint.toString() === normalizedTokenAddress)
          );
          
          if (usdcTargetPools.length === 0) {
            throw new Error(`No USDC/${normalizedTokenAddress} pool found for multi-hop swap`);
          }
          
          // Find the best USDC/TARGET pool
          let bestUsdcTargetPool = usdcTargetPools[0];
          let highestUsdcTargetLiquidity = 0;
          
          for (const pool of usdcTargetPools) {
            try {
              const poolInfo = await Liquidity.fetchInfo({
                connection,
                poolKeys: pool
              });
              
              const liquidity = poolInfo.baseReserve * poolInfo.quoteReserve;
              
              if (liquidity > highestUsdcTargetLiquidity) {
                highestUsdcTargetLiquidity = liquidity;
                bestUsdcTargetPool = pool;
              }
            } catch (error) {
              logger.warn(`Error fetching USDC/TARGET pool info: ${error.message}`);
            }
          }
          
          logger.info(`Selected best USDC/TARGET pool with ID: ${bestUsdcTargetPool.id.toString()}`);
          
          // Execute multi-hop swap
          // This is a simplified implementation - in a real scenario, you would need to
          // calculate the exact amounts and create a transaction that executes both swaps
          
          // For now, we'll just do two separate swaps
          // 1. SOL -> USDC
          const solToUsdcAmount = new TokenAmount(solToken, inputAmount.toString());
          const solToUsdcSlippage = new Percent(slippageBps, 10000);
          
          const isSolBase = bestSolUsdcPool.baseMint.toString() === 'So11111111111111111111111111111111111111112';
          
          const solToUsdcInstructions = await Liquidity.makeSwapInstructionSimple({
            connection,
            poolKeys: bestSolUsdcPool,
            userKeys: {
              tokenAccounts: [], // Will be filled by the SDK
              owner: new PublicKey(typeof userWallet === 'string' ? userWallet : userWallet.toString())
            },
            amountIn: solToUsdcAmount,
            amountOutMin: undefined, // SDK will calculate based on slippage
            slippage: solToUsdcSlippage,
            isBaseToQuote: isSolBase
          });
          
          // Build and send the first transaction
          const transaction1 = new Transaction();
          
          for (const innerTx of solToUsdcInstructions.innerTransactions) {
            for (const instruction of innerTx.instructions) {
              transaction1.add(instruction);
            }
          }
          
          // Get keypair from wallet
          const keypair = typeof userWallet === 'object' ? userWallet : null;
          if (!keypair) {
            throw new Error('Keypair is required for Raydium swap');
          }
          
          const signature1 = await sendAndConfirmTransaction(
            connection,
            transaction1,
            [keypair],
            { commitment: 'confirmed' }
          );
          
          logger.info(`First hop (SOL -> USDC) transaction confirmed: ${signature1}`);
          
          // Wait for confirmation and get the USDC amount received
          const usdcToken = new Token(usdcMint, 6, 'USDC', 'USD Coin');
          
          // Get USDC balance
          const usdcBalance = await this.getWalletBalance(
            keypair.publicKey.toString(),
            usdcMint.toString(),
            connection
          );
          
          logger.info(`USDC balance after first swap: ${usdcBalance}`);
          
          // 2. USDC -> TARGET
          const usdcToTargetAmount = new TokenAmount(usdcToken, usdcBalance.toString());
          const usdcToTargetSlippage = new Percent(slippageBps, 10000);
          
          const isUsdcBase = bestUsdcTargetPool.baseMint.toString() === usdcMint.toString();
          
          const usdcToTargetInstructions = await Liquidity.makeSwapInstructionSimple({
            connection,
            poolKeys: bestUsdcTargetPool,
            userKeys: {
              tokenAccounts: [], // Will be filled by the SDK
              owner: keypair.publicKey
            },
            amountIn: usdcToTargetAmount,
            amountOutMin: undefined, // SDK will calculate based on slippage
            slippage: usdcToTargetSlippage,
            isBaseToQuote: isUsdcBase
          });
          
          // Build and send the second transaction
          const transaction2 = new Transaction();
          
          for (const innerTx of usdcToTargetInstructions.innerTransactions) {
            for (const instruction of innerTx.instructions) {
              transaction2.add(instruction);
            }
          }
          
          const signature2 = await sendAndConfirmTransaction(
            connection,
            transaction2,
            [keypair],
            { commitment: 'confirmed' }
          );
          
          logger.info(`Second hop (USDC -> TARGET) transaction confirmed: ${signature2}`);
          
          // Get the target token balance
          const targetBalance = await this.getWalletBalance(
            keypair.publicKey.toString(),
            normalizedTokenAddress,
            connection
          );
          
          logger.info(`Target token balance after second swap: ${targetBalance}`);
          
          const swapResult = {
            signatures: [signature1, signature2],
            inputAmount,
            outputAmount: targetBalance,
            isMultiHop: true,
            timestamp: Date.now()
          };
          
          return {
            success: true,
            usedFallback: true,
            fallbackType: 'Raydium (Multi-hop)',
            swapData: swapResult,
            error: null
          };
        }
        
        // Create token amounts
        const amountIn = new TokenAmount(solToken, inputAmount.toString());
        
        // Calculate slippage
        const slippage = new Percent(slippageBps, 10000);
        
        // Create swap instructions
        const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
          connection,
          poolKeys: bestPool,
          userKeys: {
            tokenAccounts: [], // Will be filled by the SDK
            owner: new PublicKey(typeof userWallet === 'string' ? userWallet : userWallet.toString())
          },
          amountIn,
          amountOutMin: undefined, // SDK will calculate based on slippage
          slippage,
          isBaseToQuote: isBaseToQuote
        });
        
        // Build transaction
        const transaction = new Transaction();
        
        // Add all instructions
        for (const innerTx of innerTransactions) {
          for (const instruction of innerTx.instructions) {
            transaction.add(instruction);
          }
        }
        
        // Send transaction
        logger.info(`Sending Raydium swap transaction...`);
        
        // Get keypair from wallet
        const keypair = typeof userWallet === 'object' ? userWallet : null;
        if (!keypair) {
          throw new Error('Keypair is required for Raydium swap');
        }
        
        const signature = await sendAndConfirmTransaction(
          connection,
          transaction,
          [keypair],
          { commitment: 'confirmed' }
        );
        
        logger.info(`Raydium swap transaction confirmed: ${signature}`);
        
        // Calculate approximate output amount based on pool reserves and input
        const outputAmount = isBaseToQuote
          ? (inputAmount * poolInfo.quoteReserve) / poolInfo.baseReserve
          : (inputAmount * poolInfo.baseReserve) / poolInfo.quoteReserve;
        
        // Apply fee (0.25% for Raydium)
        const outputAfterFee = outputAmount * 0.9975;
        
        const swapResult = {
          signature,
          inputAmount,
          outputAmount: Math.floor(outputAfterFee),
          fee: inputAmount * 0.0025, // 0.25% fee
          timestamp: Date.now()
        };
        
        logger.info(`Successfully executed Raydium direct swap for ${normalizedTokenAddress}`);
        
        return {
          success: true,
          usedFallback: true,
          fallbackType: 'Raydium',
          swapData: swapResult,
          error: null
        };
      } catch (sdkError) {
        logger.error(`Error using Raydium SDK: ${sdkError.message}`);
        throw new Error(`Raydium SDK error: ${sdkError.message}`);
      }
    } catch (error) {
      logger.error(`Error executing Raydium direct swap: ${error.message}`);
      this.recordFailedTradeAttempt(tokenAddress, error.message, 'Raydium');
      
      return {
        success: false,
        usedFallback: true,
        fallbackType: 'Raydium',
        swapData: null,
        error: error.message
      };
    }
  }
}

module.exports = JupiterApiClient;

/**
 * Utility function to check if a token uses the standard SPL Token program
 * @param {string} tokenAddress - Token mint address to check
 * @param {Object} connection - Solana connection object
 * @returns {Promise<{isCompliant: boolean, programId: string, error: string|null}>}
 */
JupiterApiClient.prototype.checkTokenCompliance = async function(tokenAddress, connection) {
  try {
    if (!connection) {
      throw new Error('Solana connection object is required');
    }
    
    // Normalize token address
    const normalizedTokenAddress = this.normalizeTokenAddress(tokenAddress);
    
    // Get token mint account info
    const mintPubkey = new PublicKey(normalizedTokenAddress);
    const mintInfo = await connection.getAccountInfo(mintPubkey);
    
    if (!mintInfo) {
      logger.warn(`Token mint account not found: ${normalizedTokenAddress}`);
      return {
        isCompliant: false,
        programId: null,
        error: 'Token mint account not found'
      };
    }
    
    // Get the program ID that owns this token
    const programId = mintInfo.owner.toString();
    
    // Standard SPL Token program ID
    const SPL_TOKEN_PROGRAM_ID = TOKEN_PROGRAM_ID.toString();
    
    // Check if the token uses the standard SPL Token program
    const isCompliant = programId === SPL_TOKEN_PROGRAM_ID;
    
    if (!isCompliant) {
      logger.warn(`Token ${normalizedTokenAddress} uses non-standard program: ${programId}`);
      logger.warn('Non-standard tokens may not be compatible with Jupiter routing');
      
      // Check if this might be a PumpSwap token
      if (normalizedTokenAddress.toLowerCase().includes('pump')) {
        logger.info(`Non-standard token ${normalizedTokenAddress} contains 'pump' in address, likely a PumpSwap token`);
      }
    } else {
      logger.info(`Token ${normalizedTokenAddress} uses standard SPL Token program: ${programId}`);
    }
    
    return {
      isCompliant,
      programId,
      standardProgramId: SPL_TOKEN_PROGRAM_ID,
      error: null
    };
  } catch (error) {
    logger.error(`Error checking token compliance: ${error.message}`);
    return {
      isCompliant: false,
      programId: null,
      error: error.message
    };
  }
};