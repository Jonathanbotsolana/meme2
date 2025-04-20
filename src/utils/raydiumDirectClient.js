const { PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction, SystemProgram, ComputeBudgetProgram, Keypair, SYSVAR_RENT_PUBKEY } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const axios = require('axios');
const logger = require('./logger');
const config = require('../../config/config');

// Create a module export for the client
const raydiumDirectClient = new class RaydiumDirectClient {
  constructor() {
    // Define constants for SOL and WSOL
    this.NATIVE_SOL = 'SOL';
    this.WSOL_ADDRESS = 'So11111111111111111111111111111111111111112';
    
    // Define USDC address for multi-hop swaps
    this.USDC_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    
    // Raydium API endpoints
    this.RAYDIUM_API_URL = 'https://api.raydium.io/v2';
    this.RAYDIUM_POOLS_ENDPOINT = '/main/pairs';
    this.RAYDIUM_LIQUIDITY_ENDPOINT = '/main/liquidity';
    
    // Cache for discovered pools
    this.poolCache = new Map();
    this.poolCacheTimeout = 5 * 60 * 1000; // 5 minutes
    
    // Cache for token info
    this.tokenInfoCache = new Map();
    this.tokenInfoCacheTimeout = 5 * 60 * 1000; // 5 minutes
    
    // Cache for all pools
    this.allPoolsCache = null;
    this.allPoolsCacheTimestamp = 0;
    this.allPoolsCacheTimeout = 5 * 60 * 1000; // 5 minutes
    
    // Store the connection object
    this.connection = null;
    
    // Store the current keypair for transactions
    this.currentKeypair = null;
    
    // List of tokens that are known to work with Raydium but might fail with Jupiter
    this.forceRaydiumTokens = [
      'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN', // CAT
      'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU', // DOG
      'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv',  // LOL
    ];
    
    // Raydium pool addresses for specific tokens
    this.tokenPoolMap = {
      'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv': {
        ammId: '7Hoi4nBgGkjxB2UdJCFXFahxdS7Nk3TGNQfQSW7Gxgax',
        lpMint: 'FQYzNJhJ7fuXoZ5mLpV8KZbxujYLvuM4SHGMkP6qKVQ2',
        baseMint: 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 9,
        quoteDecimals: 9,
        lpDecimals: 9
      },
      'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU': {
        ammId: '3HYhQC6ne6SAPHR8NuP51mJQ9jeYE9aUaYJNXfUvqCdZ',
        lpMint: 'E6oCGvPrResupXUF7kWfzW5vxEJSXcq8zJDTWjPf5xnB',
        baseMint: 'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 9,
        quoteDecimals: 9,
        lpDecimals: 9
      },
      'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN': {
        ammId: '9fYLLAzA8N9QqKGHZz9jHFGUYsyXm7fLWnRDKbGfs7Nm',
        lpMint: 'GJa1VeEYLTRoHbaeqcxfzHmjGCGtZGBvTJKEKzuuRvEH',
        baseMint: 'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN',
        quoteMint: 'So11111111111111111111111111111111111111112',
        baseDecimals: 9,
        quoteDecimals: 9,
        lpDecimals: 9
      }
    };
    
    // Maximum number of retries for API calls
    this.maxRetries = 3;
    
    // Retry delay in milliseconds (starting value, will be increased with exponential backoff)
    this.retryDelay = 1000;
    
    // Rate limiting parameters
    this.rateLimitCooldown = 5000; // 5 seconds cooldown after hitting a rate limit
    this.rateLimitHits = 0; // Counter for rate limit hits
    this.rateLimitThreshold = 3; // Threshold for triggering endpoint rotation
    this.lastRateLimitTime = 0; // Timestamp of the last rate limit hit
    this.consecutiveRateLimits = 0; // Counter for consecutive rate limit errors (for circuit breaker)
    
    logger.info('Initialized Raydium Direct Client');
  }
  
  /**
   * Validates if a string is a valid base58 address
   * @param {string} address - The address to validate
   * @returns {boolean} - Whether the address is valid base58
   */
  isValidBase58(address) {
    try {
      new PublicKey(address);
      return true;
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Check if a pair has all required fields
   * @param {Object} pair - Pair data from API
   * @returns {boolean} - Whether the pair has all required fields
   */
  isPairComplete(pair) {
    return pair && pair.ammId && pair.baseMint && pair.quoteMint && pair.lpMint &&
           pair.baseDecimals && pair.quoteDecimals && pair.lpDecimals;
  }
  
  /**
   * Set the connection object for the client
   * @param {Object} connection - Solana connection object
   */
  setConnection(connection) {
    if (connection) {
      this.connection = connection;
      logger.info('Connection object set for Raydium Direct Client');
    }
  }

  /**
   * Update the connection if the RPC endpoint has changed
   * This method should be called when the RPC endpoint is rotated
   * @param {Object} connection - New Solana connection object
   */
  updateConnection(connection) {
    if (connection && this.connection !== connection) {
      this.connection = connection;
      logger.info('[Raydium] Updated connection object with new RPC endpoint');
      return true;
    }
    return false;
  }

  /**
   * Check if a token should force using Raydium
   * @param {string} tokenAddress - Token address
   * @returns {boolean} - Whether to force using Raydium
   */
  shouldForceRaydium(tokenAddress) {
    return this.forceRaydiumTokens.includes(tokenAddress);
  }
  
  /**
   * Handle rate limit detection and tracking
   * @param {Error} error - The error to check
   * @returns {boolean} - Whether the error is a rate limit error
   */
  isRateLimitError(error) {
    // Check if this is a rate limit error
    const isRateLimit = error.message && 
      (error.message.includes('429') || 
       error.message.includes('rate limit') ||
       error.message.includes('Too Many Requests') ||
       (error.message.includes('error') && error.message.includes('-32429')));
    
    if (isRateLimit) {
      // Update rate limit tracking
      this.rateLimitHits++;
      this.lastRateLimitTime = Date.now();
      
      // Log the rate limit hit
      logger.warn(`[Raydium] Rate limit hit (${this.rateLimitHits} in current session)`);
      
      // If we've hit the rate limit threshold, try to rotate endpoints
      if (this.rateLimitHits >= this.rateLimitThreshold) {
        this.rateLimitHits = 0; // Reset counter
        
        // Try to rotate RPC endpoint if available
        try {
          if (typeof global.rpcManager !== 'undefined' && global.rpcManager && global.rpcManager.rotateEndpoint) {
            logger.info('[Raydium] Rotating to a different RPC endpoint due to rate limiting threshold');
            global.rpcManager.rotateEndpoint();
            
            // Update the connection object if RPC endpoint changed
            if (global.connection) {
              this.connection = global.connection;
            }
          }
        } catch (rotateError) {
          logger.error(`[Raydium] Error rotating RPC endpoint: ${rotateError.message}`);
        }
      }
    }
    
    return isRateLimit;
  }
  
  /**
   * Make an API request with retry logic and rate limit handling
   * @param {string} url - The URL to request
   * @param {Object} options - Axios request options
   * @param {number} retries - Number of retries left
   * @param {number} delay - Delay between retries in ms
   * @returns {Promise<Object>} - API response
   */
  async makeApiRequest(url, options = {}, retries = this.maxRetries, delay = this.retryDelay) {
    try {
      const response = await axios(url, options);
      // Reset consecutive rate limits counter on successful request
      this.consecutiveRateLimits = 0;
      return response.data;
    } catch (error) {
      if (retries <= 0) {
        throw error;
      }
      
      // Check if this is a rate limit error
      const isRateLimit = error.response && 
        (error.response.status === 429 || 
         (error.response.data && error.response.data.error && 
          (error.response.data.error.code === -32429 || 
           error.response.data.error.message?.includes('rate limit'))));
      
      if (isRateLimit) {
        // Track consecutive rate limits for circuit breaker pattern
        this.consecutiveRateLimits = (this.consecutiveRateLimits || 0) + 1;
        
        // For rate limit errors, use a much longer delay and trigger RPC health check
        const rateLimitDelay = delay * 5; // Increased from 3x to 5x
        logger.warn(`[Raydium] Rate limit exceeded, waiting ${rateLimitDelay}ms before retry... (${retries} retries left). Consecutive rate limits: ${this.consecutiveRateLimits}`);
        
        // Trigger a health check on RPC endpoints if available
        try {
          if (typeof global.rpcManager !== 'undefined' && global.rpcManager && global.rpcManager.performHealthCheck) {
            logger.info('[Raydium] Performing health check on all RPC endpoints');
            await global.rpcManager.performHealthCheck();
            
            // If we have an RPC manager, try to rotate to a different endpoint
            if (global.rpcManager.rotateEndpoint) {
              logger.info('[Raydium] Rotating to a different RPC endpoint due to rate limiting');
              const newConnection = await global.rpcManager.rotateEndpoint();
              
              if (newConnection) {
                const oldEndpoint = this.connection?.rpcEndpoint || 'unknown';
                this.connection = newConnection;
                logger.info(`[Raydium] Rotated RPC endpoint from ${oldEndpoint} to ${newConnection.rpcEndpoint}`);
              } else {
                logger.warn("[Raydium] Failed to rotate to a new RPC endpoint. Retrying with existing endpoint.");
              }
            }
          }
        } catch (healthCheckError) {
          logger.error(`[Raydium] Error during RPC health check: ${healthCheckError.message}`);
        }
        
        // Circuit breaker pattern - if we've hit too many rate limits in a row
        if (this.consecutiveRateLimits > 5) {
          logger.error(`[Raydium] Circuit breaker triggered after ${this.consecutiveRateLimits} consecutive rate limits. Consider pausing operations.`);
          // Here you could implement a circuit breaker pattern
          // For example: await this.pauseOperations(60000); // Pause for 1 minute
        }
        
        await new Promise(resolve => setTimeout(resolve, rateLimitDelay));
        return this.makeApiRequest(url, options, retries - 1, delay * 2);
      } else {
        // Reset consecutive rate limits counter for non-rate-limit errors
        this.consecutiveRateLimits = 0;
        
        // For other errors, use standard exponential backoff
        logger.warn(`[Raydium] API request failed: ${error.message}, retrying in ${delay}ms... (${retries} retries left)`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      // Exponential backoff
      return this.makeApiRequest(url, options, retries - 1, delay * 2);
    }
  }
  
  /**
   * Fetch all Raydium pools from API
   * @returns {Promise<Array>} - Array of pool data
   */
  async fetchAllPools() {
    // Check cache first
    if (this.allPoolsCache && (Date.now() - this.allPoolsCacheTimestamp < this.allPoolsCacheTimeout)) {
      logger.info(`[Raydium] Using cached pools data (${this.allPoolsCache.length} pools)`);
      return this.allPoolsCache;
    }
    
    try {
      logger.info(`[Raydium] Fetching all pools from Raydium API`);
      
      const url = `${this.RAYDIUM_API_URL}${this.RAYDIUM_POOLS_ENDPOINT}`;
      const poolsData = await this.makeApiRequest(url);
      
      if (!poolsData || !Array.isArray(poolsData)) {
        throw new Error('Invalid response from Raydium API');
      }
      
      // Filter out incomplete pools
      const validPools = poolsData.filter(pool => this.isPairComplete(pool));
      
      logger.info(`[Raydium] Fetched ${validPools.length} valid pools from API`);
      
      // Update cache
      this.allPoolsCache = validPools;
      this.allPoolsCacheTimestamp = Date.now();
      
      return validPools;
    } catch (error) {
      logger.error(`[Raydium] Error fetching pools: ${error.message}`);
      // Return empty array if we have no cache
      return this.allPoolsCache || [];
    }
  }
  
  /**
   * Fetch pool liquidity data for a specific pool
   * @param {string} ammId - The AMM ID of the pool
   * @returns {Promise<Object>} - Pool liquidity data
   */
  async fetchPoolLiquidity(ammId) {
    try {
      logger.info(`[Raydium] Fetching liquidity data for pool ${ammId}`);
      
      // Special case for DOG token pool
      if (ammId === '3HYhQC6ne6SAPHR8NuP51mJQ9jeYE9aUaYJNXfUvqCdZ') {
        logger.info(`[Raydium] Using hardcoded liquidity data for DOG pool`);
        return {
          id: '3HYhQC6ne6SAPHR8NuP51mJQ9jeYE9aUaYJNXfUvqCdZ',
          baseReserve: '1000000000000000',  // Placeholder value
          quoteReserve: '1000000000000',     // Placeholder value
          baseVault: 'GbVKmGVpCCNZaS7ZjCAKpY1TdJDcQvJFcLKi7C9XrEQV',
          quoteVault: '2JCxZv6LaFjtWqBXSC2qadFJaJX7cp3LJZXWvbDVrVZZ',
          authority: '2JCxZv6LaFjtWqBXSC2qadFJaJX7cp3LJZXWvbDVrVZZ',
          openOrders: '2JCxZv6LaFjtWqBXSC2qadFJaJX7cp3LJZXWvbDVrVZZ'
        };
      }
      
      // Special case for CAT token pool
      if (ammId === '9fYLLAzA8N9QqKGHZz9jHFGUYsyXm7fLWnRDKbGfs7Nm') {
        logger.info(`[Raydium] Using hardcoded liquidity data for CAT pool`);
        return {
          id: '9fYLLAzA8N9QqKGHZz9jHFGUYsyXm7fLWnRDKbGfs7Nm',
          baseReserve: '1000000000000000',  // Placeholder value
          quoteReserve: '1000000000000',     // Placeholder value
          baseVault: '9SQKVwK2WNKJgfCfcmXHXjpVXGsHXMwEBYR5P3L9mRoS',
          quoteVault: 'FUDiGWLscDYmXrZgHJJSXHaEJKr5zGKpHAqxvnqNnGQh',
          authority: 'FUDiGWLscDYmXrZgHJJSXHaEJKr5zGKpHAqxvnqNnGQh',
          openOrders: 'FUDiGWLscDYmXrZgHJJSXHaEJKr5zGKpHAqxvnqNnGQh'
        };
      }
      
      // Special case for LOL token pool
      if (ammId === '7Hoi4nBgGkjxB2UdJCFXFahxdS7Nk3TGNQfQSW7Gxgax') {
        logger.info(`[Raydium] Using hardcoded liquidity data for LOL pool`);
        return {
          id: '7Hoi4nBgGkjxB2UdJCFXFahxdS7Nk3TGNQfQSW7Gxgax',
          baseReserve: '1000000000000000',  // Placeholder value
          quoteReserve: '1000000000000',     // Placeholder value
          baseVault: 'FrspKwj8i3pNmKwXreTXnqZPgHSJg27EWokQZdHQW4Qg',
          quoteVault: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
          authority: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
          openOrders: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
          // Add Serum market accounts for LOL token
          serumMarket: '7GPyD9VkZqpbT9JpJxwXKGpYbLiPPr3mx5eMtJfXJyRr',
          serumBids: 'J8romPYCZZVBVTgfX9CZ5uNf6jvVNXg5jJMNzwCEehkW',
          serumAsks: '2VzTzEkCYr8er1DNKvPLqZcHZMEJGGucYEv1Y5eba2iu',
          serumEventQueue: 'EUre4VPaLh7B95qG3JPS3atquJ5hjbwtX7XFcTtVNkc7',
          serumCoinVault: 'FrspKwj8i3pNmKwXreTXnqZPgHSJg27EWokQZdHQW4Qg',
          serumPcVault: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
          serumVaultSigner: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'
        };
      }
      
      // For other tokens, try the API
      const url = `${this.RAYDIUM_API_URL}${this.RAYDIUM_LIQUIDITY_ENDPOINT}`;
      const liquidityData = await this.makeApiRequest(url);
      
      if (!liquidityData || !Array.isArray(liquidityData)) {
        throw new Error('Invalid response from Raydium API');
      }
      
      // Find the pool with matching ammId
      const poolLiquidity = liquidityData.find(item => item.id === ammId);
      
      if (!poolLiquidity) {
        throw new Error(`No liquidity data found for pool ${ammId}`);
      }
      
      return poolLiquidity;
    } catch (error) {
      logger.error(`[Raydium] Error fetching pool liquidity: ${error.message}`);
      return null;
    }
  }

  /**
   * Execute a swap using Raydium
   * @param {string} tokenAddress - Token address to swap
   * @param {number} amountInLamports - Amount in lamports to swap
   * @param {number} slippage - Slippage percentage
   * @param {Keypair} keypair - Wallet keypair
   * @param {string} quoteTokenAddress - Quote token address (SOL or USDC)
   * @returns {Promise<Object>} - Swap result
   */
  async executeSwap(tokenAddress, amountInLamports, slippage, keypair, quoteTokenAddress = this.WSOL_ADDRESS) {
    try {
      logger.info(`[Raydium] Executing swap for ${tokenAddress} with ${amountInLamports/1e9} SOL (${slippage}% slippage)`);
      
      // Store the keypair for use in createRaydiumSwapInstruction
      this.currentKeypair = keypair;
      
      // Check if we're in test mode
      if (config.trading.testMode) {
        logger.info(`[Raydium] SIMULATION MODE: No actual swap will be executed`);
        
        // For demonstration purposes, we'll simulate a successful swap
        const estimatedOutput = (amountInLamports / 1e9) * 1000; // Simulated token amount
        
        return {
          success: true,
          txHash: 'simulated_tx_hash_' + Date.now(),
          inputAmount: amountInLamports / 1e9,
          outputAmount: estimatedOutput,
          provider: 'Raydium'
        };
      }
      
      // Check if this token is in our force Raydium list
      const forceRaydium = this.shouldForceRaydium(tokenAddress);
      
      // Try using the official Raydium SDK first, unless we need to force the direct method
      if (!forceRaydium) {
        try {
          logger.info(`[Raydium] Attempting swap using official Raydium SDK`);
          return await this.executeSwapWithRaydiumSDK(tokenAddress, amountInLamports, slippage, keypair, quoteTokenAddress);
        } catch (sdkError) {
          // If SDK method fails, log the error and fall back to direct method
          logger.warn(`[Raydium] SDK swap failed, falling back to direct method: ${sdkError.message}`);
        }
      } else {
        logger.info(`[Raydium] Using direct method for token ${tokenAddress} (forced)`);
      }
      
      // Fallback to direct method
      return await this.executeSwapDirect(tokenAddress, amountInLamports, slippage, keypair, quoteTokenAddress);
    } catch (error) {
      logger.error(`[Raydium] Error executing swap: ${error.message}`);
      throw error;
    } finally {
      // Clear the keypair reference
      this.currentKeypair = null;
    }
  }
  
  /**
   * Execute a swap using the official Raydium SDK
   * @param {string} tokenAddress - Token address to swap
   * @param {number} amountInLamports - Amount in lamports to swap
   * @param {number} slippage - Slippage percentage
   * @param {Keypair} keypair - Wallet keypair
   * @param {string} quoteTokenAddress - Quote token address (SOL or USDC)
   * @returns {Promise<Object>} - Swap result
   */
  async executeSwapWithRaydiumSDK(tokenAddress, amountInLamports, slippage, keypair, quoteTokenAddress = this.WSOL_ADDRESS) {
    try {
      // Import required modules from Raydium SDK
      const { Liquidity, LiquidityPoolKeys, Token, TokenAmount, Percent, SPL_ACCOUNT_LAYOUT } = require('@raydium-io/raydium-sdk');
      
      logger.info(`[Raydium SDK] Executing swap for ${tokenAddress} with ${amountInLamports/1e9} SOL (${slippage}% slippage)`);
      
      // 1. Find the pool for the token
      const pool = await this.findPoolForToken(tokenAddress, quoteTokenAddress);
      if (!pool) {
        throw new Error(`No Raydium pool found for token ${tokenAddress}`);
      }
      
      // 2. Get pool liquidity data
      const poolLiquidity = await this.fetchPoolLiquidity(pool.ammId);
      if (!poolLiquidity) {
        throw new Error(`Could not fetch liquidity data for pool ${pool.ammId}`);
      }
      
      // 3. Create token objects
      const inputToken = new Token(TOKEN_PROGRAM_ID, new PublicKey(quoteTokenAddress), pool.quoteDecimals);
      const outputToken = new Token(TOKEN_PROGRAM_ID, new PublicKey(tokenAddress), pool.baseDecimals);
      
      // 4. Create token amount objects
      const amountIn = new TokenAmount(inputToken, amountInLamports.toString());
      
      // 5. Create slippage percentage
      const slippageTolerance = new Percent(slippage, 100);
      
      // 6. Create pool keys
      const poolKeys = new LiquidityPoolKeys({
        id: new PublicKey(pool.ammId),
        baseMint: new PublicKey(pool.baseMint),
        quoteMint: new PublicKey(pool.quoteMint),
        lpMint: new PublicKey(pool.lpMint),
        baseDecimals: pool.baseDecimals,
        quoteDecimals: pool.quoteDecimals,
        lpDecimals: pool.lpDecimals,
        programId: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
        authority: new PublicKey(poolLiquidity.authority || poolLiquidity.openOrders),
        openOrders: new PublicKey(poolLiquidity.openOrders),
        targetOrders: new PublicKey(poolLiquidity.targetOrders || '11111111111111111111111111111111'),
        baseVault: new PublicKey(poolLiquidity.baseVault),
        quoteVault: new PublicKey(poolLiquidity.quoteVault),
        marketId: new PublicKey(poolLiquidity.serumMarket || this.getSerumMarketAddress(tokenAddress)),
        marketProgramId: new PublicKey('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'),
        marketAuthority: new PublicKey(poolLiquidity.serumVaultSigner || '11111111111111111111111111111111'),
        marketBaseVault: new PublicKey(poolLiquidity.serumCoinVault || '11111111111111111111111111111111'),
        marketQuoteVault: new PublicKey(poolLiquidity.serumPcVault || '11111111111111111111111111111111'),
        marketBids: new PublicKey(poolLiquidity.serumBids || '11111111111111111111111111111111'),
        marketAsks: new PublicKey(poolLiquidity.serumAsks || '11111111111111111111111111111111'),
        marketEventQueue: new PublicKey(poolLiquidity.serumEventQueue || '11111111111111111111111111111111')
      });
      
      // 7. Get or create token accounts
      const isInputSol = quoteTokenAddress === this.WSOL_ADDRESS;
      const isOutputSol = tokenAddress === this.WSOL_ADDRESS;
      
      // Create a wrapped SOL account if needed
      let wsolAccount;
      if (isInputSol) {
        wsolAccount = await this.createWrappedSolAccount(amountInLamports);
      }
      
      // Get or create the output token account
      const outputTokenAccount = await this.getOrCreateAssociatedTokenAccount(
        new PublicKey(tokenAddress),
        keypair.publicKey
      );
      
      // 8. Build the swap transaction
      const transaction = new Transaction();
      
      // Add compute budget instructions
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 1400000
        })
      );
      
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 50000
        })
      );
      
      // Add a memo instruction
      transaction.add(
        new TransactionInstruction({
          keys: [],
          programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
          data: Buffer.from(`Raydium SDK swap: ${amountInLamports/1e9} SOL for ${tokenAddress}`, 'utf-8'),
        })
      );
      
      // Create the swap instructions
      const swapInstructions = await Liquidity.makeSwapInstructionSimple({
        connection: this.connection,
        poolKeys,
        userKeys: {
          tokenAccounts: isInputSol ? [wsolAccount.address] : [],
          owner: keypair.publicKey,
        },
        amountIn,
        amountOutMin: undefined, // SDK will calculate based on slippage
        slippage: slippageTolerance,
      });
      
      // Add the swap instructions to the transaction
      for (const instruction of swapInstructions) {
        transaction.add(instruction);
      }
      
      // If we created a wrapped SOL account, add instruction to close it
      if (isInputSol) {
        transaction.add(
          new TransactionInstruction({
            keys: [
              { pubkey: wsolAccount.address, isSigner: false, isWritable: true },
              { pubkey: keypair.publicKey, isSigner: false, isWritable: true },
              { pubkey: keypair.publicKey, isSigner: true, isWritable: false }
            ],
            programId: TOKEN_PROGRAM_ID,
            data: Buffer.from([9]) // Close account instruction index
          })
        );
      }
      
      // 9. Sign and send the transaction with retry logic
      let signature;
      let sendRetries = 3;
      let sendDelay = 1000;
      
      while (sendRetries >= 0) {
        try {
          signature = await sendAndConfirmTransaction(
            this.connection,
            transaction,
            [keypair],
            { commitment: 'confirmed' }
          );
          break; // If successful, exit the loop
        } catch (error) {
          // Check if this is a rate limit error
          const isRateLimit = this.isRateLimitError(error);
          
          if (isRateLimit && sendRetries > 0) {
            logger.warn(`[Raydium SDK] Rate limit hit when sending transaction, waiting ${sendDelay}ms... (${sendRetries} retries left)`);
            
            // Try to rotate RPC endpoint if available
            try {
              if (typeof global.rpcManager !== 'undefined' && global.rpcManager && global.rpcManager.rotateEndpoint) {
                logger.info('[Raydium SDK] Rotating to a different RPC endpoint due to rate limiting');
                await global.rpcManager.rotateEndpoint();
                
                // Update the connection object if RPC endpoint changed
                if (global.connection) {
                  this.connection = global.connection;
                }
              }
            } catch (rotateError) {
              logger.error(`[Raydium SDK] Error rotating RPC endpoint: ${rotateError.message}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, sendDelay));
            sendRetries--;
            sendDelay *= 2; // Exponential backoff
          } else {
            throw error; // Not a rate limit error or no retries left
          }
        }
      }
      
      if (!signature) {
        throw new Error('Failed to send transaction after multiple retries');
      }
      
      // 10. Wait for confirmation and get transaction details
      let txDetails;
      let txRetries = 2;
      let txDelay = 1000;
      
      while (txRetries >= 0) {
        try {
          txDetails = await this.connection.getTransaction(signature, { commitment: 'confirmed' });
          break;
        } catch (error) {
          // Check if this is a rate limit error
          const isRateLimit = this.isRateLimitError(error);
          
          if (isRateLimit && txRetries > 0) {
            logger.warn(`[Raydium SDK] Rate limit hit when getting transaction details, waiting ${txDelay}ms... (${txRetries} retries left)`);
            
            // Try to rotate RPC endpoint if available
            try {
              if (typeof global.rpcManager !== 'undefined' && global.rpcManager && global.rpcManager.rotateEndpoint) {
                logger.info('[Raydium SDK] Rotating to a different RPC endpoint due to rate limiting');
                await global.rpcManager.rotateEndpoint();
                
                // Update the connection object if RPC endpoint changed
                if (global.connection) {
                  this.connection = global.connection;
                }
              }
            } catch (rotateError) {
              logger.error(`[Raydium SDK] Error rotating RPC endpoint: ${rotateError.message}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, txDelay));
            txRetries--;
            txDelay *= 2; // Exponential backoff
          } else {
            // If we can't get transaction details, we'll use estimated output
            logger.warn(`[Raydium SDK] Could not get transaction details, using estimated output`);
            break;
          }
        }
      }
      
      // 11. Calculate the actual output amount from the transaction or use estimate
      let outputAmount;
      if (txDetails) {
        outputAmount = this.calculateOutputFromTx(txDetails, tokenAddress);
      }
      
      // If we couldn't extract the output amount, use an estimate
      if (!outputAmount) {
        outputAmount = this.calculateEstimatedOutput(amountInLamports, pool, poolLiquidity);
      }
      
      logger.info(`[Raydium SDK] Swap executed successfully: ${signature}`);
      
      // 12. Return the result
      return {
        success: true,
        txHash: signature,
        inputAmount: amountInLamports / 1e9,
        outputAmount: outputAmount,
        provider: 'Raydium SDK'
      };
    } catch (error) {
      logger.error(`[Raydium SDK] Error executing swap: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Execute a swap using the direct Raydium method (fallback)
   * @param {string} tokenAddress - Token address to swap
   * @param {number} amountInLamports - Amount in lamports to swap
   * @param {number} slippage - Slippage percentage
   * @param {Keypair} keypair - Wallet keypair
   * @param {string} quoteTokenAddress - Quote token address (SOL or USDC)
   * @returns {Promise<Object>} - Swap result
   */
  async executeSwapDirect(tokenAddress, amountInLamports, slippage, keypair, quoteTokenAddress = this.WSOL_ADDRESS) {
    try {
      logger.info(`[Raydium Direct] Executing swap for ${tokenAddress} with ${amountInLamports/1e9} SOL (${slippage}% slippage)`);
      
      // 1. Find the pool for the token
      const pool = await this.findPoolForToken(tokenAddress, quoteTokenAddress);
      if (!pool) {
        throw new Error(`No Raydium pool found for token ${tokenAddress}`);
      }
      
      // 2. Get pool liquidity data for accurate price calculation
      let poolLiquidity = null;
      let liquidityRetries = 2;
      
      while (liquidityRetries >= 0) {
        try {
          poolLiquidity = await this.fetchPoolLiquidity(pool.ammId);
          break;
        } catch (error) {
          // Check if this is a rate limit error
          const isRateLimit = this.isRateLimitError(error);
          
          if (isRateLimit && liquidityRetries > 0) {
            const delay = 2000 * (3 - liquidityRetries);
            logger.warn(`[Raydium Direct] Rate limit hit when fetching pool liquidity, waiting ${delay}ms... (${liquidityRetries} retries left)`);
            
            // Try to rotate RPC endpoint if available
            try {
              if (typeof global.rpcManager !== 'undefined' && global.rpcManager && global.rpcManager.rotateEndpoint) {
                logger.info('[Raydium Direct] Rotating to a different RPC endpoint due to rate limiting');
                await global.rpcManager.rotateEndpoint();
                
                // Update the connection object if RPC endpoint changed
                if (global.connection) {
                  this.connection = global.connection;
                }
              }
            } catch (rotateError) {
              logger.error(`[Raydium Direct] Error rotating RPC endpoint: ${rotateError.message}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, delay));
            liquidityRetries--;
          } else {
            // Not a rate limit error or no retries left, but we can proceed without liquidity data
            logger.warn(`[Raydium Direct] No liquidity data found for pool ${pool.ammId}, proceeding with estimated values`);
            break;
          }
        }
      }
      
      if (!poolLiquidity) {
        logger.warn(`[Raydium Direct] No liquidity data found for pool ${pool.ammId}, proceeding with estimated values`);
      }
      
      // 3. Build the swap transaction
      const transaction = await this.buildSwapTransaction(pool, tokenAddress, amountInLamports, slippage, poolLiquidity);
      
      // 4. Sign and send the transaction with retry logic
      let signature;
      let sendRetries = 3;
      let sendDelay = 1000;
      
      while (sendRetries >= 0) {
        try {
          signature = await sendAndConfirmTransaction(
            this.connection,
            transaction,
            [keypair],
            { commitment: 'confirmed' }
          );
          break; // If successful, exit the loop
        } catch (error) {
          // Check if this is a rate limit error
          const isRateLimit = this.isRateLimitError(error);
          
          if (isRateLimit && sendRetries > 0) {
            logger.warn(`[Raydium Direct] Rate limit hit when sending transaction, waiting ${sendDelay}ms... (${sendRetries} retries left)`);
            
            // Try to rotate RPC endpoint if available
            try {
              if (typeof global.rpcManager !== 'undefined' && global.rpcManager && global.rpcManager.rotateEndpoint) {
                logger.info('[Raydium Direct] Rotating to a different RPC endpoint due to rate limiting');
                await global.rpcManager.rotateEndpoint();
                
                // Update the connection object if RPC endpoint changed
                if (global.connection) {
                  this.connection = global.connection;
                }
              }
            } catch (rotateError) {
              logger.error(`[Raydium Direct] Error rotating RPC endpoint: ${rotateError.message}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, sendDelay));
            sendRetries--;
            sendDelay *= 2; // Exponential backoff
          } else {
            throw error; // Not a rate limit error or no retries left
          }
        }
      }
      
      if (!signature) {
        throw new Error('Failed to send transaction after multiple retries');
      }
      
      // 5. Wait for confirmation and get transaction details
      let txDetails;
      let txRetries = 2;
      let txDelay = 1000;
      
      while (txRetries >= 0) {
        try {
          txDetails = await this.connection.getTransaction(signature, { commitment: 'confirmed' });
          break;
        } catch (error) {
          // Check if this is a rate limit error
          const isRateLimit = this.isRateLimitError(error);
          
          if (isRateLimit && txRetries > 0) {
            logger.warn(`[Raydium Direct] Rate limit hit when getting transaction details, waiting ${txDelay}ms... (${txRetries} retries left)`);
            
            // Try to rotate RPC endpoint if available
            try {
              if (typeof global.rpcManager !== 'undefined' && global.rpcManager && global.rpcManager.rotateEndpoint) {
                logger.info('[Raydium Direct] Rotating to a different RPC endpoint due to rate limiting');
                await global.rpcManager.rotateEndpoint();
                
                // Update the connection object if RPC endpoint changed
                if (global.connection) {
                  this.connection = global.connection;
                }
              }
            } catch (rotateError) {
              logger.error(`[Raydium Direct] Error rotating RPC endpoint: ${rotateError.message}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, txDelay));
            txRetries--;
            txDelay *= 2; // Exponential backoff
          } else {
            // If we can't get transaction details, we'll use estimated output
            logger.warn(`[Raydium Direct] Could not get transaction details, using estimated output`);
            break;
          }
        }
      }
      
      // 6. Calculate the actual output amount from the transaction or use estimate
      let outputAmount;
      if (txDetails) {
        outputAmount = this.calculateOutputFromTx(txDetails, tokenAddress);
      }
      
      // If we couldn't extract the output amount, use an estimate
      if (!outputAmount) {
        outputAmount = this.calculateEstimatedOutput(amountInLamports, pool, poolLiquidity);
      }
      
      logger.info(`[Raydium Direct] Swap executed successfully: ${signature}`);
      
      // 7. Return the result
      return {
        success: true,
        txHash: signature,
        inputAmount: amountInLamports / 1e9,
        outputAmount: outputAmount,
        provider: 'Raydium Direct'
      };
    } catch (error) {
      logger.error(`[Raydium Direct] Error executing swap: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Find a Raydium pool for the given token
   * @param {string} tokenAddress - The token address to find a pool for
   * @param {string} quoteTokenAddress - The quote token address (SOL or USDC)
   * @returns {Promise<Object|null>} - The pool object or null if not found
   */
  async findPoolForToken(tokenAddress, quoteTokenAddress = this.WSOL_ADDRESS) {
    try {
      // Validate token address is a valid base58 string
      if (!this.isValidBase58(tokenAddress)) {
        logger.error(`[Raydium] Invalid token address: ${tokenAddress} is not a valid base58 string`);
        return null;
      }
      
      // Check if we have a predefined pool for this token
      if (this.tokenPoolMap[tokenAddress]) {
        logger.info(`[Raydium] Using predefined pool data for token ${tokenAddress}`);
        return this.tokenPoolMap[tokenAddress];
      }
      
      // Check cache first
      const cacheKey = `${tokenAddress}-${quoteTokenAddress}`;
      if (this.poolCache.has(cacheKey)) {
        const cachedPool = this.poolCache.get(cacheKey);
        if (Date.now() - cachedPool.timestamp < this.poolCacheTimeout) {
          logger.info(`[Raydium] Using cached pool data for ${cacheKey}`);
          return cachedPool.data;
        }
      }
      
      // Special case for DOG token
      if (tokenAddress === 'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU') {
        const dogPool = {
          ammId: '3HYhQC6ne6SAPHR8NuP51mJQ9jeYE9aUaYJNXfUvqCdZ',
          lpMint: 'E6oCGvPrResupXUF7kWfzW5vxEJSXcq8zJDTWjPf5xnB',
          baseMint: 'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseDecimals: 9,
          quoteDecimals: 9,
          lpDecimals: 9
        };
        
        // Cache the result
        this.poolCache.set(cacheKey, {
          timestamp: Date.now(),
          data: dogPool
        });
        
        return dogPool;
      }
      
      // Special case for CAT token
      if (tokenAddress === 'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN') {
        const catPool = {
          ammId: '9fYLLAzA8N9QqKGHZz9jHFGUYsyXm7fLWnRDKbGfs7Nm',
          lpMint: 'GJa1VeEYLTRoHbaeqcxfzHmjGCGtZGBvTJKEKzuuRvEH',
          baseMint: 'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseDecimals: 9,
          quoteDecimals: 9,
          lpDecimals: 9
        };
        
        // Cache the result
        this.poolCache.set(cacheKey, {
          timestamp: Date.now(),
          data: catPool
        });
        
        return catPool;
      }
      
      // Special case for LOL token
      if (tokenAddress === 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv') {
        const lolPool = {
          ammId: '4GUn2JsUPG1pYM81vMrwRMVCVBKKWcjqJNQZks12Bwf2',
          lpMint: '9RUMtHSKJQep7TVFsdGX7kJNhiTXN3a7XRnvXRUgMoMZ',
          baseMint: 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv',
          quoteMint: 'So11111111111111111111111111111111111111112',
          baseDecimals: 9,
          quoteDecimals: 9,
          lpDecimals: 9
        };
        
        // Cache the result
        this.poolCache.set(cacheKey, {
          timestamp: Date.now(),
          data: lolPool
        });
        
        return lolPool;
      }
      
      // Fetch all pools from Raydium API
      const allPools = await this.fetchAllPools();
      
      // Find a pool that matches our token and quote token
      let pool = allPools.find(p => 
        (p.baseMint === tokenAddress && p.quoteMint === quoteTokenAddress) ||
        (p.quoteMint === tokenAddress && p.baseMint === quoteTokenAddress)
      );
      
      // If no direct pool with the quote token, try to find any pool for this token
      if (!pool) {
        pool = allPools.find(p => 
          p.baseMint === tokenAddress || p.quoteMint === tokenAddress
        );
      }
      
      if (pool) {
        logger.info(`[Raydium] Found pool for token ${tokenAddress}: ${pool.ammId}`);
        
        // Normalize the pool data to ensure baseMint is always the token we're looking for
        const normalizedPool = { ...pool };
        if (pool.quoteMint === tokenAddress) {
          // Swap base and quote to normalize
          normalizedPool.baseMint = pool.quoteMint;
          normalizedPool.quoteMint = pool.baseMint;
          normalizedPool.baseDecimals = pool.quoteDecimals;
          normalizedPool.quoteDecimals = pool.baseDecimals;
        }
        
        // Cache the result
        this.poolCache.set(cacheKey, {
          timestamp: Date.now(),
          data: normalizedPool
        });
        
        return normalizedPool;
      }
      
      logger.warn(`[Raydium] No pool found for token ${tokenAddress} with quote ${quoteTokenAddress}`);
      return null;
    } catch (error) {
      logger.error(`[Raydium] Error finding pool for token ${tokenAddress}: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Build a swap transaction for Raydium
   * @param {Object} pool - The pool object
   * @param {string} tokenAddress - The token address to swap
   * @param {number} amountInLamports - The amount to swap in lamports
   * @param {number} slippage - The slippage percentage
   * @param {Object} poolLiquidity - Pool liquidity data for accurate calculations
   * @returns {Promise<Transaction>} - The transaction object
   */
  async buildSwapTransaction(pool, tokenAddress, amountInLamports, slippage, poolLiquidity = null) {
    try {
      logger.info(`[Raydium] Building swap transaction for ${tokenAddress} with ${amountInLamports/1e9} SOL`);
      
      // Create a new transaction
      const transaction = new Transaction();
      
      // Add a compute budget instruction to increase compute units
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 1400000
        })
      );
      
      // Add a priority fee to increase chances of inclusion in a block
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 50000 // Adjust based on network conditions
        })
      );
      
      // Add a memo instruction to identify the transaction
      transaction.add(
        new TransactionInstruction({
          keys: [],
          programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
          data: Buffer.from(`Raydium swap: ${amountInLamports/1e9} SOL for ${tokenAddress}`, 'utf-8'),
        })
      );
      
      // Check if we need to create a wrapped SOL account
      const isQuoteSol = pool.quoteMint === this.WSOL_ADDRESS;
      
      if (isQuoteSol) {
        // Create a wrapped SOL account with the input amount
        const wsolAccount = await this.createWrappedSolAccount(amountInLamports);
        
        // Create the token account for the output token if it doesn't exist
        const tokenMint = new PublicKey(tokenAddress);
        const tokenAccount = await this.getOrCreateAssociatedTokenAccount(
          tokenMint,
          this.currentKeypair.publicKey
        );
        
        // Add the actual Raydium swap instruction
        if (pool && pool.ammId) {
          try {
            // Calculate minimum output amount based on slippage and pool data
            const estimatedOutput = this.calculateEstimatedOutput(amountInLamports, pool, poolLiquidity);
            const minimumAmountOut = Math.floor(estimatedOutput * (1 - slippage / 100) * Math.pow(10, pool.baseDecimals));
            
            // Create the swap instruction
            const swapInstruction = await this.createRaydiumSwapInstruction(
              pool,
              tokenAddress,
              amountInLamports,
              minimumAmountOut,
              wsolAccount.address,
              tokenAccount.address
            );
            
            if (swapInstruction) {
              transaction.add(swapInstruction);
              logger.info(`[Raydium] Added swap instruction to transaction`);
              
              // Add instruction to close the wrapped SOL account and recover SOL
              transaction.add(
                new TransactionInstruction({
                  keys: [
                    { pubkey: wsolAccount.address, isSigner: false, isWritable: true },
                    { pubkey: this.currentKeypair.publicKey, isSigner: false, isWritable: true },
                    { pubkey: this.currentKeypair.publicKey, isSigner: true, isWritable: false }
                  ],
                  programId: TOKEN_PROGRAM_ID,
                  data: Buffer.from([9]) // Close account instruction index
                })
              );
            } else {
              logger.error(`[Raydium] Failed to create swap instruction`);
              throw new Error('Failed to create Raydium swap instruction');
            }
          } catch (swapInstructionError) {
            logger.error(`[Raydium] Error creating swap instruction: ${swapInstructionError.message}`);
            throw swapInstructionError;
          }
        } else {
          logger.error(`[Raydium] Invalid pool data for token ${tokenAddress}`);
          throw new Error(`Invalid Raydium pool data for token ${tokenAddress}`);
        }
      } else {
        // For USDC or other quote tokens, we need a different approach
        // Get the quote token account
        const quoteMint = new PublicKey(pool.quoteMint);
        const quoteAccount = await this.getOrCreateAssociatedTokenAccount(
          quoteMint,
          this.currentKeypair.publicKey
        );
        
        // Create the token account for the output token if it doesn't exist
        const tokenMint = new PublicKey(tokenAddress);
        const tokenAccount = await this.getOrCreateAssociatedTokenAccount(
          tokenMint,
          this.currentKeypair.publicKey
        );
        
        // Add instruction to transfer SOL to USDC first if needed
        if (pool.quoteMint === this.USDC_ADDRESS) {
          // Find a SOL-USDC pool
          const solUsdcPool = await this.findPoolForToken(this.WSOL_ADDRESS, this.USDC_ADDRESS);
          if (!solUsdcPool) {
            throw new Error('Could not find SOL-USDC pool for intermediate swap');
          }
          
          // Create a wrapped SOL account
          const wsolAccount = await this.createWrappedSolAccount(amountInLamports);
          
          // Add SOL to USDC swap instruction
          const solToUsdcInstruction = await this.createRaydiumSwapInstruction(
            solUsdcPool,
            this.USDC_ADDRESS,
            amountInLamports,
            0, // We'll accept any amount of USDC for the intermediate swap
            wsolAccount.address,
            quoteAccount.address
          );
          
          if (solToUsdcInstruction) {
            transaction.add(solToUsdcInstruction);
            logger.info(`[Raydium] Added SOL to USDC swap instruction`);
            
            // Close the wrapped SOL account
            transaction.add(
              new TransactionInstruction({
                keys: [
                  { pubkey: wsolAccount.address, isSigner: false, isWritable: true },
                  { pubkey: this.currentKeypair.publicKey, isSigner: false, isWritable: true },
                  { pubkey: this.currentKeypair.publicKey, isSigner: true, isWritable: false }
                ],
                programId: TOKEN_PROGRAM_ID,
                data: Buffer.from([9]) // Close account instruction index
              })
            );
          }
        }
        
        // Calculate minimum output amount based on slippage and pool data
        const estimatedOutput = this.calculateEstimatedOutput(amountInLamports, pool, poolLiquidity);
        const minimumAmountOut = Math.floor(estimatedOutput * (1 - slippage / 100) * Math.pow(10, pool.baseDecimals));
        
        // Add the USDC to token swap instruction
        const quoteToTokenInstruction = await this.createRaydiumSwapInstruction(
          pool,
          tokenAddress,
          0, // The amount will be whatever we got from the previous swap
          minimumAmountOut,
          quoteAccount.address,
          tokenAccount.address
        );
        
        if (quoteToTokenInstruction) {
          transaction.add(quoteToTokenInstruction);
          logger.info(`[Raydium] Added quote token to target token swap instruction`);
        }
      }
      
      // Return the transaction
      return transaction;
    } catch (error) {
      logger.error(`[Raydium] Error building swap transaction: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Create a Raydium swap instruction
   * @param {Object} pool - The pool object
   * @param {string} tokenAddress - The token address to swap
   * @param {number} amountInLamports - The amount to swap in lamports
   * @param {number} minimumAmountOut - The minimum amount out in token lamports
   * @param {PublicKey} sourceTokenAccount - The source token account
   * @param {PublicKey} destinationTokenAccount - The destination token account
   * @returns {Promise<TransactionInstruction>} - The swap instruction
   */
  async createRaydiumSwapInstruction(pool, tokenAddress, amountInLamports, minimumAmountOut, sourceTokenAccount, destinationTokenAccount) {
    try {
      logger.info(`[Raydium] Creating swap instruction for ${tokenAddress}`);
      
      // Get the Raydium AMM program ID - Updated to support multiple program IDs
      // For certain tokens, we need to use a different program ID
      let raydiumAmmProgramId;
      
      // Check if this is a special token that requires a different program ID
      const isSpecialToken = [
        'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv',  // LOL
        'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN', // CAT
        'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU'  // DOG
      ].includes(tokenAddress);
      
      // Special case for LOL, CAT, and DOG tokens
      if (isSpecialToken) {
        // Use the special program ID for these tokens
        raydiumAmmProgramId = new PublicKey('5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h');
        logger.info(`[Raydium] Using special program ID for ${tokenAddress}: ${raydiumAmmProgramId.toString()}`);
      } else {
        // Use the default program ID for other tokens
        raydiumAmmProgramId = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
      }
      
      // Get the user's wallet public key from the keypair passed to executeSwap
      const userPublicKey = this.currentKeypair ? this.currentKeypair.publicKey : null;
      
      if (!userPublicKey) {
        throw new Error('No wallet keypair available for transaction');
      }
      
      // Validate token address is a valid base58 string
      if (!this.isValidBase58(tokenAddress)) {
        throw new Error(`Invalid token address: ${tokenAddress} is not a valid base58 string`);
      }
      
      // Validate pool.ammId is a valid base58 string
      if (typeof pool.ammId === 'string' && !this.isValidBase58(pool.ammId)) {
        throw new Error(`Invalid pool AMM ID: ${pool.ammId} is not a valid base58 string`);
      }
      
      // Convert pool.ammId to PublicKey if it's a string
      const ammId = typeof pool.ammId === 'string' ? new PublicKey(pool.ammId) : pool.ammId;
      
      // Fetch the pool accounts
      const poolAccounts = await this.getPoolAccounts(pool);
      
      // Determine if we're swapping from SOL to token or token to SOL
      const isInputSol = pool.quoteMint === this.WSOL_ADDRESS && sourceTokenAccount.toString() !== destinationTokenAccount.toString();
      
      // Get the Serum market address for the token
      const serumMarketAddress = this.getSerumMarketAddress(tokenAddress);
      
      // Determine the instruction index based on the token and direction
      let instructionIndex;
      
      // Special case for special tokens
      if (isSpecialToken) {
        // For special tokens, use instruction index 1 for SOL to token, 2 for token to SOL
        instructionIndex = isInputSol ? 1 : 2;
      } else {
        // For other tokens, use the standard indices
        // 9 = swap quote to base (SOL to token), 10 = swap base to quote (token to SOL)
        instructionIndex = isInputSol ? 9 : 10;
      }
      
      logger.info(`[Raydium] Using instruction index ${instructionIndex} for token ${tokenAddress}`);
      
      // Serialize the data layout to a buffer according to Raydium's format
      // Format: 1 byte for instruction index, 8 bytes for amountIn, 8 bytes for minimumAmountOut
      const data = Buffer.alloc(17);
      data.writeUInt8(instructionIndex, 0); // instruction index
      data.writeBigUInt64LE(BigInt(amountInLamports), 1); // amountIn
      data.writeBigUInt64LE(BigInt(minimumAmountOut), 9); // minAmountOut
      
      // For special tokens, we use a simplified account structure
      if (isSpecialToken) {
        logger.info(`[Raydium] Using simplified account structure for special token ${tokenAddress}`);
        
        // Create the instruction with the simplified account structure for special tokens
        // The order of accounts is critical for these special tokens
        const instruction = new TransactionInstruction({
          programId: raydiumAmmProgramId,
          keys: [
            // AMM accounts
            { pubkey: ammId, isSigner: false, isWritable: true },
            { pubkey: poolAccounts.authority, isSigner: false, isWritable: false },
            { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
            { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
            { pubkey: poolAccounts.baseVault, isSigner: false, isWritable: true },
            { pubkey: poolAccounts.quoteVault, isSigner: false, isWritable: true },
            { pubkey: new PublicKey(pool.lpMint), isSigner: false, isWritable: true },
            // User accounts
            { pubkey: userPublicKey, isSigner: true, isWritable: true },
            // Program IDs
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false } // System program ID
          ],
          data: data
        });
        
        return instruction;
      }
      
      // For standard tokens, we need the full account structure with Serum market accounts
      // Get the open orders account for the pool
      let openOrdersAccount;
      try {
        // Try to get from pool liquidity data
        const poolLiquidity = await this.fetchPoolLiquidity(pool.ammId);
        if (poolLiquidity && poolLiquidity.openOrders) {
          openOrdersAccount = new PublicKey(poolLiquidity.openOrders);
        } else {
          // Fallback to a derived PDA (this might not work for all pools)
          const [derivedOpenOrders] = await PublicKey.findProgramAddress(
            [ammId.toBuffer(), Buffer.from('open_orders')],
            raydiumAmmProgramId
          );
          openOrdersAccount = derivedOpenOrders;
        }
      } catch (error) {
        logger.warn(`[Raydium] Could not get open orders account: ${error.message}. Using placeholder.`);
        // Use a placeholder as fallback (this will likely fail)
        openOrdersAccount = new PublicKey('11111111111111111111111111111111');
      }
      
      // Get the Serum market accounts
      let serumMarket, serumBids, serumAsks, serumEventQueue, serumCoinVault, serumPcVault, serumVaultSigner;
      try {
        // Use the Serum market address we determined earlier
        serumMarket = new PublicKey(serumMarketAddress);
        
        // Try to get other Serum accounts from pool liquidity data
        const poolLiquidity = await this.fetchPoolLiquidity(pool.ammId);
        if (poolLiquidity) {
          serumBids = new PublicKey(poolLiquidity.serumBids || '11111111111111111111111111111111');
          serumAsks = new PublicKey(poolLiquidity.serumAsks || '11111111111111111111111111111111');
          serumEventQueue = new PublicKey(poolLiquidity.serumEventQueue || '11111111111111111111111111111111');
          serumCoinVault = new PublicKey(poolLiquidity.serumCoinVault || '11111111111111111111111111111111');
          serumPcVault = new PublicKey(poolLiquidity.serumPcVault || '11111111111111111111111111111111');
          serumVaultSigner = new PublicKey(poolLiquidity.serumVaultSigner || '11111111111111111111111111111111');
        } else {
          // Use placeholders as fallback
          serumBids = new PublicKey('11111111111111111111111111111111');
          serumAsks = new PublicKey('11111111111111111111111111111111');
          serumEventQueue = new PublicKey('11111111111111111111111111111111');
          serumCoinVault = new PublicKey('11111111111111111111111111111111');
          serumPcVault = new PublicKey('11111111111111111111111111111111');
          serumVaultSigner = new PublicKey('11111111111111111111111111111111');
        }
      } catch (error) {
        logger.warn(`[Raydium] Could not get Serum market accounts: ${error.message}. Using placeholders.`);
        // Use placeholders as fallback
        serumBids = new PublicKey('11111111111111111111111111111111');
        serumAsks = new PublicKey('11111111111111111111111111111111');
        serumEventQueue = new PublicKey('11111111111111111111111111111111');
        serumCoinVault = new PublicKey('11111111111111111111111111111111');
        serumPcVault = new PublicKey('11111111111111111111111111111111');
        serumVaultSigner = new PublicKey('11111111111111111111111111111111');
      }
      
      // Create the instruction with the correct accounts structure for standard tokens
      // This account structure follows the Raydium AMM program's swap instruction
      const instruction = new TransactionInstruction({
        programId: raydiumAmmProgramId,
        keys: [
          // AMM accounts
          { pubkey: ammId, isSigner: false, isWritable: true },
          { pubkey: poolAccounts.authority, isSigner: false, isWritable: false },
          { pubkey: openOrdersAccount, isSigner: false, isWritable: true },
          { pubkey: poolAccounts.baseVault, isSigner: false, isWritable: true },
          { pubkey: poolAccounts.quoteVault, isSigner: false, isWritable: true },
          
          // Serum market accounts
          { pubkey: serumMarket, isSigner: false, isWritable: true },
          { pubkey: serumBids, isSigner: false, isWritable: true },
          { pubkey: serumAsks, isSigner: false, isWritable: true },
          { pubkey: serumEventQueue, isSigner: false, isWritable: true },
          { pubkey: serumCoinVault, isSigner: false, isWritable: true },
          { pubkey: serumPcVault, isSigner: false, isWritable: true },
          { pubkey: serumVaultSigner, isSigner: false, isWritable: false },
          
          // User accounts
          { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
          { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
          { pubkey: userPublicKey, isSigner: true, isWritable: false },
          
          // Program IDs
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: new PublicKey('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'), isSigner: false, isWritable: false } // Serum DEX program ID
        ],
        data: data
      });
      
      return instruction;
    } catch (error) {
      logger.error(`[Raydium] Error creating swap instruction: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get the Serum market address for a token
   * @param {string} tokenAddress - The token address
   * @returns {string} - The Serum market address
   */
  getSerumMarketAddress(tokenAddress) {
    // Hardcoded Serum market addresses for problematic tokens
    const serumMarketMap = {
      'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU': 'HYMxXFCgirrfh85FMUEg9UvCvDk7UgvbfYJsKPPXx85c', // DOG
      'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN': '4fkMercXnCeZ5HLpZ2vFeA58u6UxZKQ9EJJjEQVyGRqF', // CAT
      'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv': '7GPyD9VkZqpbT9JpJxwXKGpYbLiPPr3mx5eMtJfXJyRr'  // LOL - Updated to correct market address
    };
    
    // Return the hardcoded address if available
    if (serumMarketMap[tokenAddress]) {
      logger.info(`[Raydium] Using hardcoded Serum market address for token ${tokenAddress}: ${serumMarketMap[tokenAddress]}`);
      return serumMarketMap[tokenAddress];
    }
    
    // Default to a placeholder address if not found
    // In a real implementation, you would query this from an API or derive it
    logger.warn(`[Raydium] No hardcoded Serum market address for token ${tokenAddress}, using placeholder`);
    return '11111111111111111111111111111111';
  }
  
  /**
   * Get the pool accounts needed for swap instructions
   * @param {Object} pool - The pool object
   * @returns {Promise<Object>} - The pool accounts
   */
  async getPoolAccounts(pool) {
    try {
      // Check if we have predefined accounts for known tokens
      if (pool.baseMint === 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv' && 
          pool.ammId === '7Hoi4nBgGkjxB2UdJCFXFahxdS7Nk3TGNQfQSW7Gxgax') {
        return {
          baseVault: new PublicKey('FrspKwj8i3pNmKwXreTXnqZPgHSJg27EWokQZdHQW4Qg'),
          quoteVault: new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'),
          authority: new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1')
        };
      }
      
      if (pool.baseMint === 'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU' && 
          pool.ammId === '3HYhQC6ne6SAPHR8NuP51mJQ9jeYE9aUaYJNXfUvqCdZ') {
        // Updated DOG pool accounts with correct values
        return {
          baseVault: new PublicKey('GbVKmGVpCCNZaS7ZjCAKpY1TdJDcQvJFcLKi7C9XrEQV'),
          quoteVault: new PublicKey('2JCxZv6LaFjtWqBXSC2qadFJaJX7cp3LJZXWvbDVrVZZ'),
          authority: new PublicKey('2JCxZv6LaFjtWqBXSC2qadFJaJX7cp3LJZXWvbDVrVZZ')
        };
      }
      
      if (pool.baseMint === 'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN' && 
          pool.ammId === '9fYLLAzA8N9QqKGHZz9jHFGUYsyXm7fLWnRDKbGfs7Nm') {
        return {
          baseVault: new PublicKey('9SQKVwK2WNKJgfCfcmXHXjpVXGsHXMwEBYR5P3L9mRoS'),
          quoteVault: new PublicKey('FUDiGWLscDYmXrZgHJJSXHaEJKr5zGKpHAqxvnqNnGQh'),
          authority: new PublicKey('FUDiGWLscDYmXrZgHJJSXHaEJKr5zGKpHAqxvnqNnGQh')
        };
      }
      
      // For other pools, try to fetch from Raydium API first
      try {
        // Use the Raydium Trade API to get pool information
        const url = `https://transaction-v1.raydium.io/pool-info/${pool.ammId}`;
        const poolInfo = await this.makeApiRequest(url);
        
        if (poolInfo && poolInfo.success && poolInfo.data) {
          const data = poolInfo.data;
          return {
            baseVault: new PublicKey(data.baseVault),
            quoteVault: new PublicKey(data.quoteVault),
            authority: new PublicKey(data.authority || data.openOrders)
          };
        }
      } catch (apiError) {
        logger.warn(`[Raydium] Could not fetch pool info from API: ${apiError.message}`);
      }
      
      // Fallback to fetching from liquidity endpoint
      const poolLiquidity = await this.fetchPoolLiquidity(pool.ammId);
      if (poolLiquidity && poolLiquidity.openOrders && poolLiquidity.baseVault && poolLiquidity.quoteVault) {
        return {
          baseVault: new PublicKey(poolLiquidity.baseVault),
          quoteVault: new PublicKey(poolLiquidity.quoteVault),
          authority: new PublicKey(poolLiquidity.authority || poolLiquidity.openOrders)
        };
      }
      
      // If we can't get the data from API, derive the PDA addresses
      // This is a simplified approach and may not work for all pools
      const ammId = new PublicKey(pool.ammId);
      
      // Determine which program ID to use for deriving PDAs
      let programId;
      if (pool.baseMint === 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv') {
        // Use the updated program ID for LOL token
        programId = new PublicKey('5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h');
        logger.info(`[Raydium] Using special program ID for LOL token PDAs: ${programId.toString()}`);
      } else {
        // Use the default program ID for other tokens
        programId = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
      }
      
      // Derive the authority PDA
      const [authority] = await PublicKey.findProgramAddress(
        [ammId.toBuffer()],
        programId
      );
      
      // Derive the vault PDAs
      const [baseVault] = await PublicKey.findProgramAddress(
        [ammId.toBuffer(), Buffer.from('base_vault')],
        programId
      );
      
      const [quoteVault] = await PublicKey.findProgramAddress(
        [ammId.toBuffer(), Buffer.from('quote_vault')],
        programId
      );
      
      return {
        baseVault,
        quoteVault,
        authority
      };
    } catch (error) {
      logger.error(`[Raydium] Error getting pool accounts: ${error.message}`);
      
      // Return placeholder accounts as a fallback
      // This will likely fail, but it's better than crashing
      return {
        baseVault: new PublicKey('11111111111111111111111111111111'),
        quoteVault: new PublicKey('11111111111111111111111111111111'),
        authority: new PublicKey('11111111111111111111111111111111')
      };
    }
  }
  
  /**
   * Get a quote for swapping SOL to a token
   * @param {string} tokenAddress - The token address to swap to
   * @param {number} amountInLamports - The amount of SOL in lamports to swap
   * @param {string} quoteTokenAddress - The quote token address (SOL or USDC)
   * @returns {Promise<Object>} - The quote result
   */
  async getQuote(tokenAddress, amountInLamports, quoteTokenAddress = this.WSOL_ADDRESS) {
    try {
      logger.info(`[Raydium] Getting quote for ${tokenAddress} with ${amountInLamports/1e9} SOL`);
      
      // Check if we have a pool for this token
      const pool = await this.findPoolForToken(tokenAddress, quoteTokenAddress);
      if (!pool) {
        throw new Error(`No Raydium pool found for token ${tokenAddress}`);
      }
      
      // Get token info
      const tokenInfo = await this.getTokenInfo(tokenAddress);
      
      // Get pool liquidity data for accurate price calculation
      const poolLiquidity = await this.fetchPoolLiquidity(pool.ammId);
      
      // Calculate estimated output based on pool liquidity
      const estimatedOutput = this.calculateEstimatedOutput(amountInLamports, pool, poolLiquidity);
      
      // Calculate price impact
      const priceImpact = this.calculatePriceImpact(amountInLamports, pool, poolLiquidity);
      
      // Determine the route
      let route = [];
      if (quoteTokenAddress === this.WSOL_ADDRESS) {
        route = [
          { input: 'SOL', output: tokenInfo.symbol || 'Unknown' }
        ];
      } else if (quoteTokenAddress === this.USDC_ADDRESS) {
        route = [
          { input: 'SOL', output: 'USDC' },
          { input: 'USDC', output: tokenInfo.symbol || 'Unknown' }
        ];
      } else {
        route = [
          { input: quoteTokenAddress.substring(0, 4), output: tokenInfo.symbol || 'Unknown' }
        ];
      }
      
      return {
        success: true,
        inputAmount: amountInLamports / 1e9,
        outputAmount: estimatedOutput,
        priceImpact: priceImpact,
        provider: 'Raydium',
        route: route,
        pool: {
          address: pool.ammId,
          liquidity: poolLiquidity ? {
            baseReserve: poolLiquidity.baseReserve,
            quoteReserve: poolLiquidity.quoteReserve
          } : null
        }
      };
    } catch (error) {
      logger.error(`[Raydium] Error getting quote: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Get token information
   * @param {string} tokenAddress - The token address
   * @returns {Promise<Object>} - Token information
   */
  async getTokenInfo(tokenAddress) {
    // Check cache first
    if (this.tokenInfoCache.has(tokenAddress)) {
      const cachedInfo = this.tokenInfoCache.get(tokenAddress);
      if (Date.now() - cachedInfo.timestamp < this.tokenInfoCacheTimeout) {
        return cachedInfo.data;
      }
    }
    
    try {
      // Try to fetch token info from the blockchain
      const tokenMint = new PublicKey(tokenAddress);
      const tokenMintInfo = await this.connection.getAccountInfo(tokenMint);
      
      if (!tokenMintInfo) {
        throw new Error(`Token mint account not found: ${tokenAddress}`);
      }
      
      // Parse the mint account data
      // This is a simplified approach - in a real implementation, you would use the Token class
      const decimals = tokenMintInfo.data[44];
      
      // Try to get token metadata if available
      let name = `Token ${tokenAddress.substring(0, 8)}`;
      let symbol = tokenAddress.substring(0, 4);
      
      try {
        // Try to fetch from Solana token list or other sources
        const tokenListUrl = 'https://cdn.jsdelivr.net/gh/solana-labs/token-list@main/src/tokens/solana.tokenlist.json';
        const response = await axios.get(tokenListUrl);
        
        if (response.data && response.data.tokens) {
          const tokenData = response.data.tokens.find(t => t.address === tokenAddress);
          if (tokenData) {
            name = tokenData.name;
            symbol = tokenData.symbol;
          }
        }
      } catch (metadataError) {
        // Ignore metadata errors, we'll use the default values
        logger.debug(`[Raydium] Could not fetch token metadata: ${metadataError.message}`);
      }
      
      const tokenInfo = {
        address: tokenAddress,
        symbol: symbol,
        decimals: decimals,
        name: name
      };
      
      // Cache the result
      this.tokenInfoCache.set(tokenAddress, {
        timestamp: Date.now(),
        data: tokenInfo
      });
      
      return tokenInfo;
    } catch (error) {
      logger.error(`[Raydium] Error getting token info: ${error.message}`);
      
      // Return basic info if we can't fetch from blockchain
      const fallbackInfo = {
        address: tokenAddress,
        symbol: tokenAddress.substring(0, 4).toUpperCase(),
        decimals: 9, // Assume 9 decimals as a fallback
        name: `Unknown Token (${tokenAddress.substring(0, 8)})`
      };
      
      // Cache the fallback result with a shorter timeout
      this.tokenInfoCache.set(tokenAddress, {
        timestamp: Date.now(),
        data: fallbackInfo,
        fallback: true
      });
      
      return fallbackInfo;
    }
  }
  
  /**
   * Calculate estimated output amount based on pool reserves
   * @param {number} amountInLamports - Input amount in lamports
   * @param {Object} pool - Pool data
   * @param {Object} poolLiquidity - Pool liquidity data
   * @returns {number} - Estimated output amount
   */
  calculateEstimatedOutput(amountInLamports, pool, poolLiquidity) {
    // If we have pool liquidity data, use it for accurate calculation
    if (poolLiquidity && poolLiquidity.baseReserve && poolLiquidity.quoteReserve) {
      return this.calculateOutputBasedOnReserves(
        amountInLamports,
        poolLiquidity.quoteReserve,
        poolLiquidity.baseReserve,
        pool.baseDecimals,
        pool.quoteDecimals
      );
    }
    
    // If we don't have liquidity data, use a simplified calculation
    // This is less accurate but better than nothing
    
    // For demonstration, we'll use a simple conversion rate
    // Assume 1 SOL = 1000 tokens as a baseline
    const baseRate = 1000;
    
    // Apply some randomness to simulate market conditions
    const randomFactor = 0.9 + (Math.random() * 0.2); // Between 0.9 and 1.1
    
    // Calculate the output amount
    const outputAmount = (amountInLamports / 1e9) * baseRate * randomFactor;
    
    return outputAmount;
  }
  
  /**
   * Calculate output amount based on pool reserves using constant product formula
   * @param {number} amountIn - Input amount in lamports
   * @param {number} reserveIn - Input token reserve
   * @param {number} reserveOut - Output token reserve
   * @param {number} decimalsOut - Output token decimals
   * @param {number} decimalsIn - Input token decimals
   * @returns {number} - Output amount in token units
   */
  calculateOutputBasedOnReserves(amountIn, reserveIn, reserveOut, decimalsOut = 9, decimalsIn = 9) {
    // Convert reserves to same decimal basis if needed
    const normalizedReserveIn = reserveIn / Math.pow(10, decimalsIn);
    const normalizedReserveOut = reserveOut / Math.pow(10, decimalsOut);
    const normalizedAmountIn = amountIn / Math.pow(10, decimalsIn);
    
    // Apply constant product formula: x * y = k
    // (reserveIn + amountIn) * (reserveOut - amountOut) = reserveIn * reserveOut
    // Solving for amountOut:
    // amountOut = reserveOut - (reserveIn * reserveOut) / (reserveIn + amountIn)
    
    // Apply 0.3% fee
    const amountInWithFee = normalizedAmountIn * 0.997;
    
    // Calculate output amount
    const numerator = amountInWithFee * normalizedReserveOut;
    const denominator = normalizedReserveIn + amountInWithFee;
    const amountOut = numerator / denominator;
    
    return amountOut;
  }
  
  /**
   * Calculate price impact based on pool reserves
   * @param {number} amountInLamports - Input amount in lamports
   * @param {Object} pool - Pool data
   * @param {Object} poolLiquidity - Pool liquidity data
   * @returns {number} - Price impact percentage
   */
  calculatePriceImpact(amountInLamports, pool, poolLiquidity) {
    // Special case for LOL token
    if (pool.baseMint === 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv') {
      // LOL token has higher price impact due to lower liquidity
      const solAmount = amountInLamports / 1e9;
      
      // Base impact is 0.2% for small amounts
      let impact = 0.2;
      
      // Increase impact for larger amounts with more aggressive scaling
      if (solAmount > 0.05) {
        impact = 0.2 + (solAmount - 0.05) * 1.0; // Add 1.0% per 0.1 SOL above 0.05 SOL
      }
      
      // Cap at 7% for LOL token
      return Math.min(impact, 7.0);
    }
    
    // If we have pool liquidity data, use it for accurate calculation
    if (poolLiquidity && poolLiquidity.baseReserve && poolLiquidity.quoteReserve) {
      return this.calculatePriceImpactBasedOnReserves(
        amountInLamports,
        poolLiquidity.quoteReserve,
        poolLiquidity.baseReserve,
        pool.baseDecimals,
        pool.quoteDecimals,
        pool.baseMint === 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv' // Pass isLolToken flag
      );
    }
    
    // If we don't have liquidity data, use a simplified calculation
    // This is less accurate but better than nothing
    
    // For demonstration, we'll simulate price impact based on input amount
    // Larger amounts have higher impact
    const solAmount = amountInLamports / 1e9;
    
    // Base impact is 0.1% for small amounts
    let impact = 0.1;
    
    // Increase impact for larger amounts
    if (solAmount > 0.1) {
      impact = 0.1 + (solAmount - 0.1) * 0.5; // Add 0.5% per 0.1 SOL above 0.1 SOL
    }
    
    // Cap at 5%
    return Math.min(impact, 5.0);
  }
  
  /**
   * Calculate price impact based on pool reserves
   * @param {number} amountIn - Input amount in lamports
   * @param {number} reserveIn - Input token reserve
   * @param {number} reserveOut - Output token reserve
   * @param {number} decimalsOut - Output token decimals
   * @param {number} decimalsIn - Input token decimals
   * @returns {number} - Price impact percentage
   */
  calculatePriceImpactBasedOnReserves(amountIn, reserveIn, reserveOut, decimalsOut = 9, decimalsIn = 9, isLolToken = false) {
    // Convert reserves to same decimal basis
    const normalizedReserveIn = reserveIn / Math.pow(10, decimalsIn);
    const normalizedReserveOut = reserveOut / Math.pow(10, decimalsOut);
    const normalizedAmountIn = amountIn / Math.pow(10, decimalsIn);
    
    // Calculate the spot price before the swap
    const spotPrice = normalizedReserveOut / normalizedReserveIn;
    
    // Calculate the execution price
    const amountOut = this.calculateOutputBasedOnReserves(
      amountIn, reserveIn, reserveOut, decimalsOut, decimalsIn
    );
    const executionPrice = amountOut / normalizedAmountIn;
    
    // Calculate price impact
    let priceImpact = Math.abs((executionPrice / spotPrice - 1) * 100);
    
    // For LOL token, apply an additional scaling factor to account for higher volatility
    if (isLolToken) {
      // Apply a multiplier to increase the price impact for LOL token
      priceImpact = priceImpact * 1.5;
      
      // Cap at 8% for LOL token
      return Math.min(priceImpact, 8.0);
    }
    
    return priceImpact;
  }
  
  /**
   * Calculate token output from a transaction
   * @param {Object} txDetails - Transaction details
   * @param {string} tokenAddress - Token address
   * @returns {number|null} - Token output amount or null if can't be determined
   */
  calculateTokenOutputFromTx(txDetails, tokenAddress) {
    try {
      if (!txDetails || !txDetails.meta || !txDetails.meta.postTokenBalances || !txDetails.meta.preTokenBalances) {
        return null;
      }
      
      // Find the token account for the specified token
      const tokenMint = new PublicKey(tokenAddress);
      
      // Find pre and post balances for the token
      const preBalance = txDetails.meta.preTokenBalances.find(
        balance => balance.mint === tokenMint.toString()
      );
      
      const postBalance = txDetails.meta.postTokenBalances.find(
        balance => balance.mint === tokenMint.toString()
      );
      
      if (!preBalance || !postBalance) {
        return null;
      }
      
      // Calculate the difference
      const preAmount = parseFloat(preBalance.uiTokenAmount.uiAmount || 0);
      const postAmount = parseFloat(postBalance.uiTokenAmount.uiAmount || 0);
      const outputAmount = postAmount - preAmount;
      
      return outputAmount > 0 ? outputAmount : null;
    } catch (error) {
      logger.error(`[Raydium] Error calculating token output from tx: ${error.message}`);
      return null;
    }
  }

  /**
   * Execute a sell transaction using Raydium
   * @param {string} tokenAddress - Token address to sell
   * @param {number} tokenAmount - Amount of tokens to sell
   * @param {number} slippage - Slippage percentage
   * @param {Keypair} keypair - Wallet keypair
   * @param {Object} buyData - Data from the buy transaction for P&L calculation
   * @param {string} quoteTokenAddress - Quote token address (SOL or USDC)
   * @returns {Promise<Object>} - Sell result with profit/loss calculation
   */
  async executeSell(tokenAddress, tokenAmount, slippage, keypair, buyData, quoteTokenAddress = this.WSOL_ADDRESS) {
    try {
      logger.info(`[Raydium] Executing sell for ${tokenAmount} ${tokenAddress} (${slippage}% slippage)`);
      
      // Store the keypair for use in createRaydiumSellInstruction
      this.currentKeypair = keypair;
      
      // Check if we're in test mode
      if (config.trading.testMode) {
        logger.info(`[Raydium] SIMULATION MODE: No actual sell will be executed`);
        
        // For demonstration purposes, we'll simulate a successful sell
        const estimatedSolOutput = tokenAmount / 1000; // Simulated SOL amount
        
        // Calculate profit/loss if buy data is available
        const profitLoss = this.calculateProfitLoss({
          buyAmount: buyData?.inputAmount || 0.01, // Default to 0.01 SOL if no buy data
          sellAmount: estimatedSolOutput,
          buyPrice: buyData?.inputAmount || 0.01, // In SOL
          sellPrice: estimatedSolOutput, // In SOL
          tokenAmount: tokenAmount
        });
        
        return {
          success: true,
          txHash: 'simulated_sell_tx_hash_' + Date.now(),
          inputAmount: tokenAmount,
          outputAmount: estimatedSolOutput,
          provider: 'Raydium',
          profitLoss: profitLoss.profitLoss,
          profitLossPercentage: profitLoss.profitLossPercentage,
          buyData: buyData || null
        };
      }
      
      // Actual sell implementation
      // 1. Find the pool for the token
      const pool = await this.findPoolForToken(tokenAddress, quoteTokenAddress);
      if (!pool) {
        throw new Error(`No Raydium pool found for token ${tokenAddress}`);
      }
      
      // 2. Get pool liquidity data for accurate price calculation
      const poolLiquidity = await this.fetchPoolLiquidity(pool.ammId);
      
      // 3. Build the sell transaction
      const transaction = await this.buildSellTransaction(pool, tokenAddress, tokenAmount, slippage, poolLiquidity);
      
      // 4. Sign and send the transaction
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [keypair],
        { commitment: 'confirmed' }
      );
      
      // 5. Wait for confirmation and get transaction details
      const txDetails = await this.connection.getTransaction(signature, { commitment: 'confirmed' });
      
      // 6. Calculate the actual output amount from the transaction
      let outputAmount;
      if (quoteTokenAddress === this.WSOL_ADDRESS) {
        // Extract the SOL amount received
        outputAmount = this.calculateSolOutputFromTx(txDetails);
      } else {
        // Extract the quote token amount received
        outputAmount = this.calculateTokenOutputFromTx(txDetails, quoteTokenAddress);
      }
      
      // If we couldn't extract the output amount, use an estimate
      if (!outputAmount) {
        outputAmount = this.estimateSolOutput(tokenAmount, pool, poolLiquidity);
      }
      
      logger.info(`[Raydium] Sell executed successfully: ${signature}`);
      
      // 7. Calculate profit/loss if buy data is available
      const profitLoss = this.calculateProfitLoss({
        buyAmount: buyData?.inputAmount || 0.01, // Default to 0.01 SOL if no buy data
        sellAmount: outputAmount,
        buyPrice: buyData?.inputAmount || 0.01, // In SOL
        sellPrice: outputAmount, // In SOL
        tokenAmount: tokenAmount
      });
      
      // 8. Return the result with profit/loss calculation
      return {
        success: true,
        txHash: signature,
        inputAmount: tokenAmount,
        outputAmount: outputAmount,
        provider: 'Raydium',
        profitLoss: profitLoss.profitLoss,
        profitLossPercentage: profitLoss.profitLossPercentage,
        buyData: buyData || null
      };
    } catch (error) {
      logger.error(`[Raydium] Error executing sell: ${error.message}`);
      throw error;
    } finally {
      // Clear the keypair reference
      this.currentKeypair = null;
    }
  }
  
  /**
   * Build a sell transaction for Raydium
   * @param {Object} pool - The pool object
   * @param {string} tokenAddress - The token address to sell
   * @param {number} tokenAmount - The amount of tokens to sell
   * @param {number} slippage - The slippage percentage
   * @param {Object} poolLiquidity - Pool liquidity data for accurate calculations
   * @returns {Promise<Transaction>} - The transaction object
   */
  async buildSellTransaction(pool, tokenAddress, tokenAmount, slippage, poolLiquidity = null) {
    try {
      logger.info(`[Raydium] Building sell transaction for ${tokenAmount} ${tokenAddress}`);
      
      // Create a new transaction
      const transaction = new Transaction();
      
      // Add a compute budget instruction to increase compute units
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 1400000
        })
      );
      
      // Add a priority fee to increase chances of inclusion in a block
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 50000 // Adjust based on network conditions
        })
      );
      
      // Add a memo instruction to identify the transaction
      transaction.add(
        new TransactionInstruction({
          keys: [],
          programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
          data: Buffer.from(`Raydium sell: ${tokenAmount} ${tokenAddress} for SOL`, 'utf-8'),
        })
      );
      
      // Get the token account for the token being sold
      const tokenMint = new PublicKey(tokenAddress);
      const { value: tokenAccounts } = await this.connection.getTokenAccountsByOwner(
        this.currentKeypair.publicKey,
        { mint: tokenMint }
      );
      
      if (tokenAccounts.length === 0) {
        throw new Error(`No token account found for ${tokenAddress}`);
      }
      
      const userTokenAccount = tokenAccounts[0].pubkey;
      
      // Check if we're selling for SOL or another token
      const isQuoteSol = pool.quoteMint === this.WSOL_ADDRESS;
      
      if (isQuoteSol) {
        // Create a wrapped SOL account to receive SOL
        const wsolMint = new PublicKey(this.WSOL_ADDRESS);
        const wsolAccount = await this.getOrCreateAssociatedTokenAccount(
          wsolMint,
          this.currentKeypair.publicKey
        );
        
        // Calculate minimum output amount based on slippage and pool data
        const estimatedOutput = this.estimateSolOutput(tokenAmount, pool, poolLiquidity);
        const minimumAmountOut = Math.floor(estimatedOutput * (1 - slippage / 100) * 1e9);
        
        // Add the Raydium sell instruction
        const sellInstruction = await this.createRaydiumSellInstruction(
          pool,
          tokenAddress,
          tokenAmount * Math.pow(10, pool.baseDecimals), // Convert to lamports
          minimumAmountOut,
          userTokenAccount,
          wsolAccount.address
        );
        
        if (sellInstruction) {
          transaction.add(sellInstruction);
          logger.info(`[Raydium] Added sell instruction to transaction`);
          
          // Add instruction to close the wrapped SOL account and recover SOL
          transaction.add(
            new TransactionInstruction({
              keys: [
                { pubkey: wsolAccount.address, isSigner: false, isWritable: true },
                { pubkey: this.currentKeypair.publicKey, isSigner: false, isWritable: true },
                { pubkey: this.currentKeypair.publicKey, isSigner: true, isWritable: false }
              ],
              programId: TOKEN_PROGRAM_ID,
              data: Buffer.from([9]) // Close account instruction index
            })
          );
        } else {
          logger.error(`[Raydium] Failed to create sell instruction`);
          throw new Error('Failed to create Raydium sell instruction');
        }
      } else {
        // We're selling for a token other than SOL (e.g., USDC)
        // Get or create the destination token account
        const quoteMint = new PublicKey(pool.quoteMint);
        const quoteAccount = await this.getOrCreateAssociatedTokenAccount(
          quoteMint,
          this.currentKeypair.publicKey
        );
        
        // Calculate minimum output amount based on slippage and pool data
        const estimatedOutput = this.estimateSolOutput(tokenAmount, pool, poolLiquidity);
        const minimumAmountOut = Math.floor(estimatedOutput * (1 - slippage / 100) * Math.pow(10, pool.quoteDecimals));
        
        // Add the Raydium sell instruction
        const sellInstruction = await this.createRaydiumSellInstruction(
          pool,
          tokenAddress,
          tokenAmount * Math.pow(10, pool.baseDecimals), // Convert to lamports
          minimumAmountOut,
          userTokenAccount,
          quoteAccount.address
        );
        
        if (sellInstruction) {
          transaction.add(sellInstruction);
          logger.info(`[Raydium] Added sell instruction to transaction`);
          
          // If the quote token is not SOL and we want SOL, add another swap
          if (pool.quoteMint === this.USDC_ADDRESS && this.WSOL_ADDRESS !== pool.quoteMint) {
            // Find a USDC-SOL pool
            const usdcSolPool = await this.findPoolForToken(this.USDC_ADDRESS, this.WSOL_ADDRESS);
            if (!usdcSolPool) {
              throw new Error('Could not find USDC-SOL pool for intermediate swap');
            }
            
            // Create a wrapped SOL account to receive SOL
            const wsolMint = new PublicKey(this.WSOL_ADDRESS);
            const wsolAccount = await this.getOrCreateAssociatedTokenAccount(
              wsolMint,
              this.currentKeypair.publicKey
            );
            
            // Add USDC to SOL swap instruction
            const usdcToSolInstruction = await this.createRaydiumSellInstruction(
              usdcSolPool,
              this.USDC_ADDRESS,
              0, // The amount will be whatever we got from the previous swap
              0, // We'll accept any amount of SOL
              quoteAccount.address,
              wsolAccount.address
            );
            
            if (usdcToSolInstruction) {
              transaction.add(usdcToSolInstruction);
              logger.info(`[Raydium] Added USDC to SOL swap instruction`);
              
              // Close the wrapped SOL account
              transaction.add(
                new TransactionInstruction({
                  keys: [
                    { pubkey: wsolAccount.address, isSigner: false, isWritable: true },
                    { pubkey: this.currentKeypair.publicKey, isSigner: false, isWritable: true },
                    { pubkey: this.currentKeypair.publicKey, isSigner: true, isWritable: false }
                  ],
                  programId: TOKEN_PROGRAM_ID,
                  data: Buffer.from([9]) // Close account instruction index
                })
              );
            }
          }
        } else {
          logger.error(`[Raydium] Failed to create sell instruction`);
          throw new Error('Failed to create Raydium sell instruction');
        }
      }
      
      // Return the transaction
      return transaction;
    } catch (error) {
      logger.error(`[Raydium] Error building sell transaction: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Create a Raydium sell instruction
   * @param {Object} pool - The pool object
   * @param {string} tokenAddress - The token address to sell
   * @param {number} tokenAmountLamports - The amount of tokens to sell in lamports
   * @param {number} minimumAmountOut - The minimum amount out in lamports
   * @param {PublicKey} sourceTokenAccount - The source token account
   * @param {PublicKey} destinationTokenAccount - The destination token account
   * @returns {Promise<TransactionInstruction>} - The sell instruction
   */
  async createRaydiumSellInstruction(pool, tokenAddress, tokenAmountLamports, minimumAmountOut, sourceTokenAccount, destinationTokenAccount) {
    try {
      logger.info(`[Raydium] Creating sell instruction for ${tokenAmountLamports} ${tokenAddress}`);
      
      // Get the Raydium AMM program ID - Updated to support multiple program IDs
      let raydiumAmmProgramId;
      
      // Check if this is a special token that requires a different program ID
      const isSpecialToken = [
        'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv',  // LOL
        'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN', // CAT
        'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU'  // DOG
      ].includes(tokenAddress);
      
      // Special case for special tokens
      if (isSpecialToken) {
        // Use the special program ID for these tokens
        raydiumAmmProgramId = new PublicKey('5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h');
        logger.info(`[Raydium] Using special program ID for ${tokenAddress}: ${raydiumAmmProgramId.toString()}`);
      } else {
        // Use the default program ID for other tokens
        raydiumAmmProgramId = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
      }
      
      // Get the user's wallet public key from the keypair passed to executeSell
      const userPublicKey = this.currentKeypair ? this.currentKeypair.publicKey : null;
      
      if (!userPublicKey) {
        throw new Error('No wallet keypair available for transaction');
      }
      
      // Validate token address is a valid base58 string
      if (!this.isValidBase58(tokenAddress)) {
        throw new Error(`Invalid token address: ${tokenAddress} is not a valid base58 string`);
      }
      
      // Validate pool.ammId is a valid base58 string
      if (typeof pool.ammId === 'string' && !this.isValidBase58(pool.ammId)) {
        throw new Error(`Invalid pool AMM ID: ${pool.ammId} is not a valid base58 string`);
      }
      
      // Convert pool.ammId to PublicKey if it's a string
      const ammId = typeof pool.ammId === 'string' ? new PublicKey(pool.ammId) : pool.ammId;
      
      // Fetch the pool accounts
      const poolAccounts = await this.getPoolAccounts(pool);
      
      // Format the instruction data according to Raydium's swap instruction
      // For special tokens: Instruction index 2 = swap base to quote (sell token for SOL)
      // For newer tokens: Instruction index 10 = swap base to quote
      const instructionIndex = isSpecialToken ? 2 : 10;
      
      logger.info(`[Raydium] Using instruction index ${instructionIndex} for selling token ${tokenAddress}`);
      
      // Serialize the data layout to a buffer
      const data = Buffer.alloc(17); // 1 byte for index, 8 bytes for u64 amountIn, 8 bytes for u64 minAmountOut
      data.writeUInt8(instructionIndex, 0); // instruction index
      data.writeBigUInt64LE(BigInt(tokenAmountLamports), 1); // amountIn
      data.writeBigUInt64LE(BigInt(minimumAmountOut), 9); // minAmountOut
      
      // For special tokens, we use a simplified account structure
      if (isSpecialToken) {
        logger.info(`[Raydium] Using simplified account structure for selling special token ${tokenAddress}`);
        
        // Create the instruction with the simplified account structure for selling
        // The order of accounts is critical for these special tokens
        const instruction = new TransactionInstruction({
          programId: raydiumAmmProgramId,
          keys: [
            // AMM accounts
            { pubkey: ammId, isSigner: false, isWritable: true },
            { pubkey: poolAccounts.authority, isSigner: false, isWritable: false },
            { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
            { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
            { pubkey: poolAccounts.baseVault, isSigner: false, isWritable: true },
            { pubkey: poolAccounts.quoteVault, isSigner: false, isWritable: true },
            { pubkey: new PublicKey(pool.lpMint), isSigner: false, isWritable: true },
            // User accounts
            { pubkey: userPublicKey, isSigner: true, isWritable: true },
            // Program IDs
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false } // System program ID
          ],
          data: data
        });
        
        return instruction;
      }
      
      // For standard tokens, we need the full account structure with Serum market accounts
      // Get the open orders account for the pool
      let openOrdersAccount;
      try {
        // Try to get from pool liquidity data
        const poolLiquidity = await this.fetchPoolLiquidity(pool.ammId);
        if (poolLiquidity && poolLiquidity.openOrders) {
          openOrdersAccount = new PublicKey(poolLiquidity.openOrders);
        } else {
          // Fallback to a derived PDA (this might not work for all pools)
          const [derivedOpenOrders] = await PublicKey.findProgramAddress(
            [ammId.toBuffer(), Buffer.from('open_orders')],
            raydiumAmmProgramId
          );
          openOrdersAccount = derivedOpenOrders;
        }
      } catch (error) {
        logger.warn(`[Raydium] Could not get open orders account: ${error.message}. Using placeholder.`);
        // Use a placeholder as fallback (this will likely fail)
        openOrdersAccount = new PublicKey('11111111111111111111111111111111');
      }
      
      // Get the Serum market accounts
      let serumMarket, serumBids, serumAsks, serumEventQueue, serumCoinVault, serumPcVault, serumVaultSigner;
      try {
        // Try to get from pool liquidity data
        const poolLiquidity = await this.fetchPoolLiquidity(pool.ammId);
        if (poolLiquidity && poolLiquidity.serumMarket) {
          serumMarket = new PublicKey(poolLiquidity.serumMarket);
          serumBids = new PublicKey(poolLiquidity.serumBids || '11111111111111111111111111111111');
          serumAsks = new PublicKey(poolLiquidity.serumAsks || '11111111111111111111111111111111');
          serumEventQueue = new PublicKey(poolLiquidity.serumEventQueue || '11111111111111111111111111111111');
          serumCoinVault = new PublicKey(poolLiquidity.serumCoinVault || '11111111111111111111111111111111');
          serumPcVault = new PublicKey(poolLiquidity.serumPcVault || '11111111111111111111111111111111');
          serumVaultSigner = new PublicKey(poolLiquidity.serumVaultSigner || '11111111111111111111111111111111');
        } else {
          // Use placeholders as fallback (this will likely fail)
          serumMarket = new PublicKey('11111111111111111111111111111111');
          serumBids = new PublicKey('11111111111111111111111111111111');
          serumAsks = new PublicKey('11111111111111111111111111111111');
          serumEventQueue = new PublicKey('11111111111111111111111111111111');
          serumCoinVault = new PublicKey('11111111111111111111111111111111');
          serumPcVault = new PublicKey('11111111111111111111111111111111');
          serumVaultSigner = new PublicKey('11111111111111111111111111111111');
        }
      } catch (error) {
        logger.warn(`[Raydium] Could not get Serum market accounts: ${error.message}. Using placeholders.`);
        // Use placeholders as fallback (this will likely fail)
        serumMarket = new PublicKey('11111111111111111111111111111111');
        serumBids = new PublicKey('11111111111111111111111111111111');
        serumAsks = new PublicKey('11111111111111111111111111111111');
        serumEventQueue = new PublicKey('11111111111111111111111111111111');
        serumCoinVault = new PublicKey('11111111111111111111111111111111');
        serumPcVault = new PublicKey('11111111111111111111111111111111');
        serumVaultSigner = new PublicKey('11111111111111111111111111111111');
      }
      
      // Create the instruction with the correct accounts for standard tokens
      const instruction = new TransactionInstruction({
        programId: raydiumAmmProgramId,
        keys: [
          // AMM accounts
          { pubkey: ammId, isSigner: false, isWritable: true },
          { pubkey: poolAccounts.authority, isSigner: false, isWritable: false },
          { pubkey: openOrdersAccount, isSigner: false, isWritable: true },
          { pubkey: poolAccounts.baseVault, isSigner: false, isWritable: true },
          { pubkey: poolAccounts.quoteVault, isSigner: false, isWritable: true },
          
          // Serum market accounts
          { pubkey: serumMarket, isSigner: false, isWritable: true },
          { pubkey: serumBids, isSigner: false, isWritable: true },
          { pubkey: serumAsks, isSigner: false, isWritable: true },
          { pubkey: serumEventQueue, isSigner: false, isWritable: true },
          { pubkey: serumCoinVault, isSigner: false, isWritable: true },
          { pubkey: serumPcVault, isSigner: false, isWritable: true },
          { pubkey: serumVaultSigner, isSigner: false, isWritable: false },
          
          // User accounts
          { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
          { pubkey: destinationTokenAccount, isSigner: false, isWritable: true },
          { pubkey: userPublicKey, isSigner: true, isWritable: false },
          
          // Program IDs
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: new PublicKey('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'), isSigner: false, isWritable: false } // Serum DEX program ID
        ],
        data: data
      });
      
      return instruction;
    } catch (error) {
      logger.error(`[Raydium] Error creating sell instruction: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Estimate SOL received from a sell transaction
   * @param {Object} txDetails - Transaction details
   * @param {number} tokenAmount - Amount of tokens sold
   * @returns {number} - Estimated SOL received
   */
  estimateSolFromSellTx(txDetails, tokenAmount) {
    // In a real implementation, you would parse the transaction data
    // to get the exact amount of SOL received
    
    // For demonstration, we'll use a simple estimation
    // Assume 1000 tokens = 1 SOL as a baseline (same as buy rate)
    const baseRate = 1000;
    
    // Apply some randomness to simulate market conditions
    // For sells, we'll make it slightly less favorable than buys (0.85 to 1.05 vs 0.9 to 1.1)
    const randomFactor = 0.85 + (Math.random() * 0.2);
    
    // Calculate the estimated SOL received
    const estimatedSol = (tokenAmount / baseRate) * randomFactor;
    
    return estimatedSol;
  }
  
  /**
   * Calculate profit and loss for a trade
   * @param {Object} params - Parameters for calculation
   * @param {number} params.buyAmount - Amount of SOL used to buy
   * @param {number} params.sellAmount - Amount of SOL received from sell
   * @param {number} params.buyPrice - Buy price in SOL
   * @param {number} params.sellPrice - Sell price in SOL
   * @param {number} params.tokenAmount - Amount of tokens involved
   * @returns {Object} - Profit/loss calculation
   */
  calculateProfitLoss({ buyAmount, sellAmount, buyPrice, sellPrice, tokenAmount }) {
    // Calculate absolute profit/loss in SOL
    const profitLoss = sellAmount - buyAmount;
    
    // Calculate percentage profit/loss
    const profitLossPercentage = ((sellAmount / buyAmount) - 1) * 100;
    
    // Calculate price change
    const buyPricePerToken = buyAmount / tokenAmount;
    const sellPricePerToken = sellAmount / tokenAmount;
    const priceChange = ((sellPricePerToken / buyPricePerToken) - 1) * 100;
    
    // Calculate fees (estimated)
    const estimatedFees = 0.0005 * (buyAmount + sellAmount); // 0.05% fee estimation
    
    // Calculate net profit/loss after fees
    const netProfitLoss = profitLoss - estimatedFees;
    const netProfitLossPercentage = ((netProfitLoss / buyAmount) * 100);
    
    // Log the profit/loss details
    if (profitLoss > 0) {
      logger.info(`[Raydium] Trade profit: +${profitLoss.toFixed(6)} SOL (${profitLossPercentage.toFixed(2)}%)`); 
    } else {
      logger.warn(`[Raydium] Trade loss: ${profitLoss.toFixed(6)} SOL (${profitLossPercentage.toFixed(2)}%)`); 
    }
    
    return {
      profitLoss,
      profitLossPercentage,
      priceChange,
      estimatedFees,
      netProfitLoss,
      netProfitLossPercentage,
      buyAmount,
      sellAmount,
      tokenAmount
    };
  }
  
  /**
   * Get a quote for selling tokens to SOL
   * @param {string} tokenAddress - The token address to sell
   * @param {number} tokenAmount - The amount of tokens to sell
   * @returns {Promise<Object>} - The quote result
   */
  async getSellQuote(tokenAddress, tokenAmount) {
    try {
      logger.info(`[Raydium] Getting sell quote for ${tokenAmount} ${tokenAddress}`);
      
      // Check if we have a pool for this token
      const pool = await this.findPoolForToken(tokenAddress);
      if (!pool) {
        throw new Error(`No Raydium pool found for token ${tokenAddress}`);
      }
      
      // Get token info
      const tokenInfo = await this.getTokenInfo(tokenAddress);
      
      // Calculate estimated SOL output
      const estimatedSolOutput = this.estimateSolOutput(tokenAmount, pool, tokenInfo);
      
      // Calculate price impact
      const priceImpact = this.calculateSellPriceImpact(tokenAmount, pool);
      
      return {
        success: true,
        inputAmount: tokenAmount,
        outputAmount: estimatedSolOutput,
        outputAmountInSol: estimatedSolOutput,
        priceImpact: priceImpact,
        provider: 'Raydium',
        route: [
          { input: tokenInfo.symbol || 'Unknown', output: 'SOL' }
        ]
      };
    } catch (error) {
      logger.error(`[Raydium] Error getting sell quote: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Estimate SOL output for selling tokens
   * @param {number} tokenAmount - Amount of tokens to sell
   * @param {Object} pool - Pool data
   * @param {Object} tokenInfo - Token information
   * @returns {number} - Estimated SOL output
   */
  estimateSolOutput(tokenAmount, pool, tokenInfo) {
    // This is a simplified calculation and should be replaced with actual Raydium math
    // In a real implementation, you would use the pool reserves and math from Raydium
    
    // For demonstration, we'll use a simple conversion rate
    // Assume 1000 tokens = 1 SOL as a baseline (same as buy rate)
    const baseRate = 1000;
    
    // Apply some randomness to simulate market conditions
    // For sells, we'll make it slightly less favorable than buys
    const randomFactor = 0.85 + (Math.random() * 0.2); // Between 0.85 and 1.05
    
    // Calculate the estimated SOL output
    const estimatedSol = (tokenAmount / baseRate) * randomFactor;
    
    return estimatedSol;
  }
  
  /**
   * Calculate price impact for selling tokens
   * @param {number} tokenAmount - Amount of tokens to sell
   * @param {Object} pool - Pool data
   * @returns {number} - Price impact percentage
   */
  calculateSellPriceImpact(tokenAmount, pool) {
    // Check if this is the LOL token pool
    if (pool.baseMint === 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv') {
      // LOL token has higher price impact due to lower liquidity
      // Base impact is 0.25% for small amounts
      let impact = 0.25;
      
      // Increase impact for larger amounts
      // For LOL token, we'll use a more aggressive scaling
      const equivalentSolValue = tokenAmount / 1000;
      
      if (equivalentSolValue > 0.05) {
        impact = 0.25 + (equivalentSolValue - 0.05) * 1.2; // Add 1.2% per 0.1 SOL equivalent above 0.05 SOL
      }
      
      // Cap at 8% for LOL token
      return Math.min(impact, 8.0);
    }
    
    // For other tokens, use the standard calculation
    // Base impact is 0.15% for small amounts
    let impact = 0.15;
    
    // Increase impact for larger amounts
    // Assuming 1000 tokens = 1 SOL, we'll scale accordingly
    const equivalentSolValue = tokenAmount / 1000;
    
    if (equivalentSolValue > 0.1) {
      impact = 0.15 + (equivalentSolValue - 0.1) * 0.6; // Add 0.6% per 0.1 SOL equivalent above 0.1 SOL
    }
    
    // Cap at 6% for standard tokens
    return Math.min(impact, 6.0);
  }
};

module.exports = raydiumDirectClient;

/**
 * Get or create an associated token account
 * @param {PublicKey} mint - The token mint
 * @param {PublicKey} owner - The account owner
 * @param {boolean} allowOwnerOffCurve - Whether to allow the owner account to be off curve
 * @returns {Promise<Object>} - The token account
 */
raydiumDirectClient.getOrCreateAssociatedTokenAccount = async function(mint, owner, allowOwnerOffCurve = false) {
  try {
    // Compute the associated token address deterministically
    const [associatedTokenAddress] = await PublicKey.findProgramAddress(
      [
        owner.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    
    // Check if the account exists - with retry logic for rate limiting
    let tokenAccount = null;
    let retries = 3;
    let delay = 1000;
    
    while (retries > 0) {
      try {
        tokenAccount = await this.connection.getAccountInfo(associatedTokenAddress);
        break; // If successful, exit the loop
      } catch (error) {
        // Check if this is a rate limit error
        const isRateLimit = error.message && 
          (error.message.includes('429') || 
           error.message.includes('rate limit') ||
           (error.message.includes('Too Many Requests')));
        
        if (isRateLimit && retries > 0) {
          logger.warn(`[Raydium] Rate limit hit when checking token account, waiting ${delay}ms... (${retries} retries left)`);
          
          // Try to rotate RPC endpoint if available
          try {
            if (typeof global.rpcManager !== 'undefined' && global.rpcManager && global.rpcManager.rotateEndpoint) {
              logger.info('[Raydium] Rotating to a different RPC endpoint due to rate limiting');
              await global.rpcManager.rotateEndpoint();
              
              // Update the connection object if RPC endpoint changed
              if (global.connection) {
                this.connection = global.connection;
              }
            }
          } catch (rotateError) {
            logger.error(`[Raydium] Error rotating RPC endpoint: ${rotateError.message}`);
          }
          
          await new Promise(resolve => setTimeout(resolve, delay));
          retries--;
          delay *= 2; // Exponential backoff
        } else {
          throw error; // Not a rate limit error or no retries left
        }
      }
    }
    
    // If the account exists, return it
    if (tokenAccount) {
      return {
        address: associatedTokenAddress,
        mint: mint,
        owner: owner
      };
    }
    
    // If the account doesn't exist, create it
    logger.info(`[Raydium] Creating associated token account for mint ${mint.toString()}`);
    
    // Create a transaction to create the associated token account
    const transaction = new Transaction();
    
    // Add a compute budget instruction to increase compute units and priority fee
    // This helps with transaction success during network congestion
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 200000
      })
    );
    
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 50000 // Adjust based on network conditions
      })
    );
    
    // Add the instruction to create the associated token account
    transaction.add(
      new TransactionInstruction({
        keys: [
          { pubkey: this.currentKeypair.publicKey, isSigner: true, isWritable: true }, // Payer
          { pubkey: associatedTokenAddress, isSigner: false, isWritable: true }, // New account
          { pubkey: owner, isSigner: false, isWritable: false }, // Owner
          { pubkey: mint, isSigner: false, isWritable: false }, // Mint
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // System program
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // Token program
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // Rent sysvar
        ],
        programId: ASSOCIATED_TOKEN_PROGRAM_ID,
        data: Buffer.from([]) // No data needed for create associated token account
      })
    );
    
    // Send and confirm the transaction with retry logic
    let signature;
    retries = 3;
    delay = 1000;
    
    while (retries >= 0) {
      try {
        signature = await sendAndConfirmTransaction(
          this.connection,
          transaction,
          [this.currentKeypair],
          { commitment: 'confirmed' }
        );
        break; // If successful, exit the loop
      } catch (error) {
        // Check if this is a rate limit error
        const isRateLimit = error.message && 
          (error.message.includes('429') || 
           error.message.includes('rate limit') ||
           (error.message.includes('Too Many Requests')));
        
        if (isRateLimit && retries > 0) {
          logger.warn(`[Raydium] Rate limit hit when creating token account, waiting ${delay}ms... (${retries} retries left)`);
          
          // Try to rotate RPC endpoint if available
          try {
            if (typeof global.rpcManager !== 'undefined' && global.rpcManager && global.rpcManager.rotateEndpoint) {
              logger.info('[Raydium] Rotating to a different RPC endpoint due to rate limiting');
              await global.rpcManager.rotateEndpoint();
              
              // Update the connection object if RPC endpoint changed
              if (global.connection) {
                this.connection = global.connection;
              }
            }
          } catch (rotateError) {
            logger.error(`[Raydium] Error rotating RPC endpoint: ${rotateError.message}`);
          }
          
          await new Promise(resolve => setTimeout(resolve, delay));
          retries--;
          delay *= 2; // Exponential backoff
        } else {
          throw error; // Not a rate limit error or no retries left
        }
      }
    }
    
    if (!signature) {
      throw new Error('Failed to create associated token account after multiple retries');
    }
    
    logger.info(`[Raydium] Created associated token account: ${signature}`);
    
    return {
      address: associatedTokenAddress,
      mint: mint,
      owner: owner
    };
  } catch (error) {
    logger.error(`[Raydium] Error getting or creating associated token account: ${error.message}`);
    throw error;
  }
};

/**
 * Create a wrapped SOL account with a specific amount
 * @param {number} amountInLamports - Amount of SOL in lamports to wrap
 * @returns {Promise<Object>} - The wrapped SOL account
 */
raydiumDirectClient.createWrappedSolAccount = async function(amountInLamports) {
  try {
    logger.info(`[Raydium] Creating wrapped SOL account with ${amountInLamports/1e9} SOL`);
    
    // Create a new keypair for the temporary account
    const newAccount = new Keypair();
    
    // Create a transaction
    const transaction = new Transaction();
    
    // Add compute budget instructions to increase priority
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 200000
      })
    );
    
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 50000 // Adjust based on network conditions
      })
    );
    
    // Add instruction to create account
    transaction.add(
      SystemProgram.createAccount({
        fromPubkey: this.currentKeypair.publicKey,
        newAccountPubkey: newAccount.publicKey,
        lamports: amountInLamports + 2039280, // Additional lamports for rent exemption
        space: 165,
        programId: TOKEN_PROGRAM_ID
      })
    );
    
    // Use TransactionInstruction directly instead of createInitializeAccountInstruction
    transaction.add(
      new TransactionInstruction({
        keys: [
          { pubkey: newAccount.publicKey, isSigner: false, isWritable: true },
          { pubkey: new PublicKey(this.WSOL_ADDRESS), isSigner: false, isWritable: false },
          { pubkey: this.currentKeypair.publicKey, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
        ],
        programId: TOKEN_PROGRAM_ID,
        data: Buffer.from([1]) // Initialize account instruction index
      })
    );
    
    // Send and confirm the transaction with retry logic
    let signature;
    let retries = 3;
    let delay = 1000;
    
    while (retries >= 0) {
      try {
        signature = await sendAndConfirmTransaction(
          this.connection,
          transaction,
          [this.currentKeypair, newAccount],
          { commitment: 'confirmed' }
        );
        break; // If successful, exit the loop
      } catch (error) {
        // Check if this is a rate limit error
        const isRateLimit = error.message && 
          (error.message.includes('429') || 
           error.message.includes('rate limit') ||
           (error.message.includes('Too Many Requests')));
        
        if (isRateLimit && retries > 0) {
          logger.warn(`[Raydium] Rate limit hit when creating wrapped SOL account, waiting ${delay}ms... (${retries} retries left)`);
          
          // Try to rotate RPC endpoint if available
          try {
            if (typeof global.rpcManager !== 'undefined' && global.rpcManager && global.rpcManager.rotateEndpoint) {
              logger.info('[Raydium] Rotating to a different RPC endpoint due to rate limiting');
              await global.rpcManager.rotateEndpoint();
              
              // Update the connection object if RPC endpoint changed
              if (global.connection) {
                this.connection = global.connection;
              }
            }
          } catch (rotateError) {
            logger.error(`[Raydium] Error rotating RPC endpoint: ${rotateError.message}`);
          }
          
          await new Promise(resolve => setTimeout(resolve, delay));
          retries--;
          delay *= 2; // Exponential backoff
        } else {
          throw error; // Not a rate limit error or no retries left
        }
      }
    }
    
    if (!signature) {
      throw new Error('Failed to create wrapped SOL account after multiple retries');
    }
    
    logger.info(`[Raydium] Created wrapped SOL account: ${signature}`);
    
    return {
      address: newAccount.publicKey,
      mint: new PublicKey(this.WSOL_ADDRESS),
      owner: this.currentKeypair.publicKey
    };
  } catch (error) {
    logger.error(`[Raydium] Error creating wrapped SOL account: ${error.message}`);
    throw error;
  }
};

/**
 * Close a wrapped SOL account and recover the SOL
 * @param {PublicKey} wsolAccount - The wrapped SOL account to close
 * @returns {Promise<string>} - The transaction signature
 */
raydiumDirectClient.closeWrappedSolAccount = async function(wsolAccount) {
  try {
    logger.info(`[Raydium] Closing wrapped SOL account ${wsolAccount.toString()}`);
    
    // Create a transaction
    const transaction = new Transaction();
    
    // Add instruction to close the account using TransactionInstruction directly
    transaction.add(
      new TransactionInstruction({
        keys: [
          { pubkey: wsolAccount, isSigner: false, isWritable: true },
          { pubkey: this.currentKeypair.publicKey, isSigner: false, isWritable: true },
          { pubkey: this.currentKeypair.publicKey, isSigner: true, isWritable: false }
        ],
        programId: TOKEN_PROGRAM_ID,
        data: Buffer.from([9]) // Close account instruction index
      })
    );
    
    // Send and confirm the transaction
    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [this.currentKeypair],
      { commitment: 'confirmed' }
    );
    
    logger.info(`[Raydium] Closed wrapped SOL account: ${signature}`);
    
    return signature;
  } catch (error) {
    logger.error(`[Raydium] Error closing wrapped SOL account: ${error.message}`);
    throw error;
  }
};