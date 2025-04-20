const { Connection, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { Jupiter } = require('@jup-ag/core');
const fetch = require('node-fetch');
const bs58 = require('bs58');
const config = require('../../config/config');
const logger = require('../utils/logger');
const wallet = require('../utils/wallet');
const database = require('../utils/database');
const JupiterRateLimiter = require('../../scripts/jupiter-rate-limiter');
const rpcManager = require('../utils/rpcManager');
const apeJupiterClient = require('../utils/apeJupiterClient');
const dexScreenerClient = require('../utils/dexScreenerClient');
const pumpSwapClient = require('../utils/pumpSwapClient');
const raydiumClient = require('../utils/raydiumDirectClient');

// DEX compatibility utility functions
function isJupiterCompatible(dexName) {
  if (!dexName) return false;
  const jupiterDexes = ['raydium', 'orca', 'meteora', 'jupiter', 'phoenix', 'openbook', 'dooar', 'cykura', 'saros', 'aldrin', 'crema', 'lifinity', 'serum', 'saber'];
  return jupiterDexes.some(dex => dexName.toLowerCase().includes(dex));
}

// Helper function to check if a DEX is Raydium-compatible
function isRaydiumCompatible(dexId) {
  if (!dexId) return false;
  const raydiumDexes = ['raydium', 'raydium-fusion', 'raydium-clmm', 'raydium-v3', 'raydium-v4'];
  return raydiumDexes.some(dex => dexId.toLowerCase().includes(dex));
}

// Helper function to check if a DEX is PumpSwap-compatible
function isPumpSwapCompatible(dexId) {
  if (!dexId) return false;
  const pumpSwapDexes = ['pumpswap', 'pump-swap', 'pump-finance', 'pump'];
  return pumpSwapDexes.some(dex => dexId.toLowerCase().includes(dex));
}

class SwapExecutor {
  constructor() {
    // Use the centralized RPC manager from utils
    this.rpcManager = rpcManager;
    
    // Get the current connection from the RPC manager
    this.connection = this.rpcManager.getCurrentConnection();
    
    // Determine Jupiter tier based on config
    const jupiterTier = config.jupiter?.tier || 'free';
    const jupiterApiKey = config.jupiter?.apiKey || null;
    
    // Initialize Jupiter rate limiter with tier configuration
    this.jupiterRateLimiter = new JupiterRateLimiter({
      tier: jupiterTier,
      apiKey: jupiterApiKey,
      maxConcurrentRequests: 2,
      maxRetries: 10,
      debug: config.debug || false,
      platformFeeBps: config.jupiter?.platformFeeBps || 0,
      feeAccount: config.jupiter?.feeAccount || null
    });
    
    this.maxTradeSizeSol = config.trading.maxTradeSizeSol;
    this.defaultSlippage = config.trading.defaultSlippage;
    
    // ApeJupiter configuration
    this.useApeJupiter = config.trading.apeJupiter?.enabled || false;
    this.fallbackToJupiter = config.trading.apeJupiter?.fallbackToJupiter || true;
    
    // Jupiter API configuration
    this.useJupiterApi = config.trading.jupiterApi?.enabled !== false; // Enabled by default
    this.preferJupiterApi = config.trading.jupiterApi?.preferred || false; // Use SDK by default
    
    // DexScreener configuration
    this.useDexScreener = config.trading?.dexScreener?.enabled !== false; // Enabled by default
    this.dexScreenerMinLiquidity = config.trading?.dexScreener?.minLiquidityUsd || 1000; // Default $1000
    this.dexScreenerMinVolume = config.trading?.dexScreener?.minVolumeUsd || 100; // Default $100
    this.requireVerifiedPair = config.trading?.dexScreener?.requireVerifiedPair || false;
    this.requireJupiterCompatiblePair = config.trading?.dexScreener?.requireJupiterCompatiblePair !== false; // Enabled by default
    this.preferredDexes = config.trading?.dexScreener?.preferredDexes || ['raydium', 'orca', 'meteora', 'jupiter', 'pumpswap', 'phoenix', 'dooar'];
    
    // Current token DEX info (set during swap execution)
    this.currentTokenDexInfo = null;
    
    // PumpSwap fallback flag
    this.hasPumpSwapFallback = true;
    
    // Raydium fallback flag
    this.hasRaydiumFallback = true;
    
    // Log initialization
    logger.info(`SwapExecutor initialized with ${jupiterTier} tier (${this.jupiterRateLimiter.tierConfig.requestsPerMinute} requests/min)`);
    logger.info(`Using Jupiter API hostname: ${this.jupiterRateLimiter.getApiHostname()}`);
    logger.info(`Jupiter API direct integration: ${this.useJupiterApi ? 'Enabled' : 'Disabled'} (${this.preferJupiterApi ? 'Preferred' : 'Fallback'})`);
    logger.info(`ApeJupiter integration: ${this.useApeJupiter ? 'Enabled' : 'Disabled'}`);
    logger.info(`DexScreener integration: ${this.useDexScreener ? 'Enabled' : 'Disabled'}`);
    logger.info(`PumpSwap direct integration: ${this.hasPumpSwapFallback ? 'Enabled' : 'Disabled'} (as fallback when detected)`);
    logger.info(`Raydium direct integration: ${this.hasRaydiumFallback ? 'Enabled' : 'Disabled'} (as fallback and primary for special tokens)`);
    
    // Special token handling
    const specialTokens = [
      'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN', // CAT  
      'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU', // DOG
      'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv',  // LOL
    ];
    logger.info(`Special tokens configured for direct Raydium execution: ${specialTokens.length} tokens`);
    
    // Ensure Raydium client is properly initialized
    if (!raydiumClient) {
      logger.error(`Raydium client not properly initialized. Attempting to initialize it now.`);
      try {
        // Initialize Raydium client with the current connection
        const raydiumClientModule = require('../utils/raydiumDirectClient');
        if (raydiumClientModule) {
          // If the module exists but needs initialization
          if (typeof raydiumClientModule.initialize === 'function') {
            raydiumClientModule.initialize(this.connection);
            logger.info(`Raydium client initialized successfully.`);
          } else if (typeof raydiumClientModule.setConnection === 'function') {
            raydiumClientModule.setConnection(this.connection);
            logger.info(`Raydium client connection set successfully.`);
          } else {
            logger.info(`Raydium client module loaded but no initialization method found.`);
          }
        } else {
          logger.error(`Failed to load Raydium client module.`);
        }
      } catch (error) {
        logger.error(`Error initializing Raydium client: ${error.message}. Raydium fallbacks may not work.`);
      }
    } else {
      // Make sure the Raydium client has the connection
      if (typeof raydiumClient.setConnection === 'function') {
        raydiumClient.setConnection(this.connection);
        logger.info(`Raydium client connection set successfully.`);
      } else {
        logger.info(`Raydium client already initialized but no setConnection method found.`);
      }
    }
    if (this.useDexScreener) {
      logger.info(`DexScreener min liquidity: ${this.dexScreenerMinLiquidity}, min volume: ${this.dexScreenerMinVolume}`);
      logger.info(`Require Jupiter-compatible pairs: ${this.requireJupiterCompatiblePair ? 'Yes' : 'No'}`);
      logger.info(`Preferred DEXes: ${this.preferredDexes.join(', ')}`);
    }
  }

  async executeSwap(tokenAddress, amountInSol, slippage = null) {
    try {
      const slippageToUse = slippage || this.defaultSlippage;
      logger.info(`Executing swap for token ${tokenAddress} with ${amountInSol} SOL (slippage: ${slippageToUse}%)`);
      
      // Ensure amount is within limits
      if (amountInSol > this.maxTradeSizeSol) {
        logger.warn(`Swap amount ${amountInSol} exceeds maximum ${this.maxTradeSizeSol}. Limiting to maximum.`);
        amountInSol = this.maxTradeSizeSol;
      }
      
      // Force Raydium direct execution for specific tokens that have issues with Jupiter
      const forceRaydiumTokens = [
        'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN', // CAT  
        'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU', // DOG
        'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv',  // LOL - Requires special handling with Raydium
      ];
      
      // Check if the token is in the force Raydium list or if Raydium client says it should force Raydium
      if (forceRaydiumTokens.includes(tokenAddress) || 
          (raydiumClient.shouldForceRaydium && raydiumClient.shouldForceRaydium(tokenAddress))) {
        logger.info(`Force using Raydium direct integration for ${tokenAddress}`);
        
        // Get the keypair
        const keypair = wallet.getKeypair();
        
        // Convert SOL to lamports
        const amountInLamports = Math.floor(amountInSol * 1e9);
        
        // Always get the latest connection from the RPC manager
        this.connection = this.rpcManager.getCurrentConnection();
        
        // Make sure Raydium client has the connection
        if (raydiumClient.setConnection) {
          raydiumClient.setConnection(this.connection);
        }
        
        // Use token-specific slippage if available
        let tokenSlippage = slippageToUse;
        
        // Token-specific slippage settings
        if (tokenAddress === 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv') {
          // LOL token
          tokenSlippage = 1.0; // 1% default slippage
          logger.info(`Using token-specific slippage of ${tokenSlippage}% for LOL token (Raydium)`);
        } else if (tokenAddress === 'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN') {
          // CAT token
          tokenSlippage = 2.0; // 2% default slippage
          logger.info(`Using token-specific slippage of ${tokenSlippage}% for CAT token (Raydium)`);
        } else if (tokenAddress === 'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU') {
          // DOG token
          tokenSlippage = 2.0; // 2% default slippage
          logger.info(`Using token-specific slippage of ${tokenSlippage}% for DOG token (Raydium)`);
        }
        
        // Execute Raydium swap directly
        return await this._executeRaydiumDirectly(tokenAddress, amountInLamports, tokenSlippage, keypair);
      }
      
      // Get wallet balance
      const walletBalance = await this.getWalletBalance();
      if (walletBalance < amountInSol) {
        logger.error(`Insufficient balance: ${walletBalance} SOL, needed ${amountInSol} SOL`);
        return {
          success: false,
          error: 'Insufficient balance',
        };
      }
      
      // Check if trading is enabled
      if (!process.env.TRADING_ENABLED || process.env.TRADING_ENABLED.toLowerCase() !== 'true') {
        logger.warn('Trading is disabled. Set TRADING_ENABLED=true to enable real trading.');
        return {
          success: false,
          error: 'Trading is disabled',
        };
      }
      
      // Check for active trading pairs using DexScreener if enabled
      if (this.useDexScreener) {
        try {
          logger.info(`Checking DexScreener for active pairs for token: ${tokenAddress}`);
          const dexScreenerResult = await dexScreenerClient.checkActivePairs(tokenAddress, {
            requireVerifiedPair: this.requireVerifiedPair,
            minLiquidityUsd: this.dexScreenerMinLiquidity,
            minVolumeUsd: this.dexScreenerMinVolume,
            preferredDexes: this.preferredDexes
          });
          
          if (!dexScreenerResult.hasActivePairs) {
            logger.error(`No active trading pairs found for token ${tokenAddress} on DexScreener. Aborting swap.`);
            return {
              success: false,
              error: 'No active trading pairs found on DexScreener',
              dexScreenerResult
            };
          }
          
          // Check if we have a PumpSwap pair but no Jupiter-compatible pairs
          if (dexScreenerResult.bestPair && isPumpSwapCompatible(dexScreenerResult.bestPair.dexId)) {
            logger.info(`Found PumpSwap pair for ${tokenAddress}. Using direct PumpSwap integration.`);
            
            // Get the keypair
            const keypair = wallet.getKeypair();
            
            // Execute PumpSwap directly
            try {
              // Convert SOL amount to lamports for the direct execution
              const amountInLamports = Math.floor(amountInSol * 1e9);
              return await this._executePumpSwapDirectly(tokenAddress, amountInLamports, slippageToUse, keypair);
            } catch (pumpSwapError) {
              logger.error(`PumpSwap direct integration failed: ${pumpSwapError.message}. Trying Jupiter as fallback.`);
              // Continue with Jupiter execution
            }
          }
          
          // Check if we require Jupiter-compatible pairs
          if (this.requireJupiterCompatiblePair && !dexScreenerResult.hasJupiterCompatiblePairs) {
            logger.error(`No Jupiter-compatible trading pairs found for token ${tokenAddress}. Aborting swap.`);
            return {
              success: false,
              error: 'No Jupiter-compatible trading pairs found',
              dexScreenerResult
            };
          }
          
          // Get detailed DEX information to help with routing
          const dexInfo = await dexScreenerClient.getTokenDexInfo(tokenAddress);
          
          // Log the best pair information
          if (dexScreenerResult.bestPair) {
            const bestPair = dexScreenerResult.bestPair;
            logger.info(`Found active trading pair on ${bestPair.dexId} with ${bestPair.liquidity?.usd} liquidity and ${bestPair.volume?.h24} 24h volume`);
          }
          
          // Store DEX info for use during swap execution
          this.currentTokenDexInfo = dexInfo;
          
          if (dexInfo.jupiterCompatibleDexes.length > 0) {
            logger.info(`Jupiter-compatible DEXes for ${tokenAddress}: ${dexInfo.jupiterCompatibleDexes.join(', ')}`);
          }
          
          // Check if we have non-Jupiter DEXes that we can use directly
          const nonJupiterDexes = dexInfo.dexes.filter(dex => !isJupiterCompatible(dex));
          if (nonJupiterDexes.length > 0) {
            logger.info(`Non-Jupiter DEXes for ${tokenAddress}: ${nonJupiterDexes.join(', ')}`);
            
            // Check for Raydium specifically
          const hasRaydium = dexInfo.jupiterCompatibleDexes.some(dex => isRaydiumCompatible(dex));
          if (hasRaydium) {
            logger.info(`Token ${tokenAddress} is available on Raydium. Will try direct integration if other methods fail.`);
            this.hasRaydiumFallback = true;
          } else {
            // Also check if Raydium is in the non-Jupiter DEXes
            const hasRaydiumNonJupiter = nonJupiterDexes.some(dex => isRaydiumCompatible(dex));
            if (hasRaydiumNonJupiter) {
              logger.info(`Token ${tokenAddress} is available on Raydium (non-Jupiter). Will try direct integration if other methods fail.`);
              this.hasRaydiumFallback = true;
            } else {
              // Check if the token name or symbol contains 'LOL' as a special case
              const tokenInfo = await dexScreenerClient.getTokenInfo(tokenAddress);
              if (tokenInfo && 
                  (tokenInfo.name?.toUpperCase().includes('LOL') || 
                   tokenInfo.symbol?.toUpperCase().includes('LOL'))) {
                logger.info(`Special case: LOL token detected. Will try Raydium direct integration.`);
                this.hasRaydiumFallback = true;
              } else {
                this.hasRaydiumFallback = false;
              }
            }
          }
          
          // Check for PumpSwap specifically
          const hasPumpSwap = nonJupiterDexes.some(dex => isPumpSwapCompatible(dex));
          if (hasPumpSwap) {
            logger.info(`Token ${tokenAddress} is available on PumpSwap. Will try direct integration if Jupiter fails.`);
            this.hasPumpSwapFallback = true;
          } else {
            // Also check if PumpSwap is in the Jupiter-compatible DEXes (though unlikely)
            const hasPumpSwapJupiter = dexInfo.jupiterCompatibleDexes.some(dex => isPumpSwapCompatible(dex));
            if (hasPumpSwapJupiter) {
              logger.info(`Token ${tokenAddress} is available on PumpSwap (Jupiter-compatible). Will try direct integration if Jupiter fails.`);
              this.hasPumpSwapFallback = true;
            } else {
              this.hasPumpSwapFallback = false;
            }
          }
          } else {
            this.hasPumpSwapFallback = false;
          }
        } catch (dexScreenerError) {
          // Log the error but continue with the swap
          logger.warn(`Error checking DexScreener: ${dexScreenerError.message}. Continuing with swap anyway.`);
          this.currentTokenDexInfo = null;
          this.hasPumpSwapFallback = false;
          this.hasRaydiumFallback = false;
        }
      } else {
        this.currentTokenDexInfo = null;
        this.hasPumpSwapFallback = false;
        this.hasRaydiumFallback = false;
      }
      
      // Convert SOL amount to lamports
      const amountInLamports = Math.floor(amountInSol * 1e9);
      
      // Get the keypair
      const keypair = wallet.getKeypair();
      
      // Check if this is a memecoin and if we should use ApeJupiter
      let isMemeToken = false;
      if (this.useApeJupiter) {
        try {
          isMemeToken = await apeJupiterClient.isMemeToken(tokenAddress);
          logger.info(`Token ${tokenAddress} is ${isMemeToken ? 'a memecoin' : 'not a memecoin'}`);
        } catch (error) {
          logger.warn(`Error checking if token is a memecoin: ${error.message}. Will use standard Jupiter.`);
        }
      }
      
      // If this is a memecoin and ApeJupiter is enabled, use it
      if (this.useApeJupiter && isMemeToken) {
        try {
          logger.info(`Using ApeJupiter for memecoin swap: ${tokenAddress}`);
          return await this._executeApeJupiterSwap(tokenAddress, amountInLamports, slippageToUse, keypair);
        } catch (apeError) {
          logger.error(`ApeJupiter swap failed: ${apeError.message}`);
          
          // If fallback is enabled, try regular Jupiter
          if (this.fallbackToJupiter) {
            logger.info(`Falling back to regular Jupiter for swap`);
            // Continue to regular Jupiter execution below
          } else {
            // If no fallback, return the error
            return {
              success: false,
              error: `ApeJupiter swap failed: ${apeError.message}`,
            };
          }
        }
      }
      
      // Check if we should use Jupiter API directly (if preferred)
      if (this.useJupiterApi && this.preferJupiterApi) {
        try {
          logger.info(`Using Jupiter API directly for swap: ${tokenAddress}`);
          return await this.executeJupiterApiSwap(tokenAddress, amountInSol, slippageToUse);
        } catch (jupiterApiError) {
          logger.error(`Jupiter API direct swap failed: ${jupiterApiError.message}. Falling back to SDK.`);
          // Continue to standard Jupiter SDK execution below
        }
      }
      
      // Standard Jupiter execution path
      try {
        // Always get the latest connection from the RPC manager
        this.connection = this.rpcManager.getCurrentConnection();
        
        // Initialize Jupiter with rate limiting
        const jupiterInstance = await this.jupiterRateLimiter.execute(async () => {
          return await Jupiter.load({
            connection: this.connection,
            cluster: 'mainnet-beta',
            user: keypair,
            apiKey: this.jupiterRateLimiter.config.apiKey, // Use API key from rate limiter
          });
        }, false); // Not a Price API call
        
        // Define input and output tokens
        const inputMint = new PublicKey('So11111111111111111111111111111111111111112'); // SOL
        const outputMint = new PublicKey(tokenAddress); // Target token
        
        // Get routes with rate limiting
        const routes = await this.jupiterRateLimiter.execute(async () => {
          return await jupiterInstance.computeRoutes({
            inputMint,
            outputMint,
            amount: amountInLamports,
            slippageBps: Math.floor(slippageToUse * 100), // Convert percentage to basis points
            forceFetch: true, // Force fetch fresh data
          });
        }, false); // Not a Price API call
        
        if (!routes.routesInfos || routes.routesInfos.length === 0) {
          logger.error(`No routes found for swap from SOL to ${tokenAddress}`);
          
          // If ApeJupiter is enabled, try it as a fallback even for non-memecoins
          // when Jupiter can't find routes
          if (this.useApeJupiter) {
            logger.info(`No Jupiter routes found. Trying ApeJupiter as fallback for: ${tokenAddress}`);
            try {
              return await this._executeApeJupiterSwap(tokenAddress, amountInLamports, slippageToUse, keypair);
            } catch (apeError) {
              logger.error(`ApeJupiter fallback swap failed: ${apeError.message}`);
              // Continue to error handling
            }
          }
          
          // If Jupiter API is enabled, try it as a fallback
          if (this.useJupiterApi && !this.preferJupiterApi) {
            logger.info(`No Jupiter SDK routes found. Trying Jupiter API as fallback for: ${tokenAddress}`);
            try {
              return await this.executeJupiterApiSwap(tokenAddress, amountInSol, slippageToUse);
            } catch (jupiterApiError) {
              logger.error(`Jupiter API fallback swap failed: ${jupiterApiError.message}`);
              // Continue to error handling
            }
          }
          
          // Try one more time with a different RPC endpoint before giving up
          logger.info('Trying with a different RPC endpoint for No Routes error...');
          const oldEndpoint = this.rpcManager.getCurrentEndpoint();
          this.connection = this.rpcManager.rotateEndpoint();
          logger.info(`Rotated from ${oldEndpoint} to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
          
          try {
            // Initialize Jupiter with the new connection
            const jupiterRetryInstance = await this.jupiterRateLimiter.execute(async () => {
              return await Jupiter.load({
                connection: this.connection,
                cluster: 'mainnet-beta',
                user: keypair,
                apiKey: this.jupiterRateLimiter.config.apiKey,
              });
            }, false);
            
            // Get routes with rate limiting and higher slippage
            const retryRoutes = await this.jupiterRateLimiter.execute(async () => {
              return await jupiterRetryInstance.computeRoutes({
                inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
                outputMint: new PublicKey(tokenAddress),
                amount: amountInLamports,
                slippageBps: 2500, // Use 25% slippage for retry
                forceFetch: true, // Force fetch fresh data
              });
            }, false);
            
            if (!retryRoutes.routesInfos || retryRoutes.routesInfos.length === 0) {
              logger.error(`Still no routes found with new RPC endpoint. Giving up.`);
              return {
                success: false,
                error: 'No routes found after multiple attempts',
              };
            }
            
            // Found routes on retry!
            const bestRoute = retryRoutes.routesInfos[0];
            logger.info(`Found route on retry with output: ${bestRoute.outAmount} tokens`);
            
            // Execute the swap with rate limiting
            const { execute } = await this.jupiterRateLimiter.execute(async () => {
              return await jupiterRetryInstance.exchange({
                routeInfo: bestRoute,
              });
            }, false);
            
            const result = await this.jupiterRateLimiter.execute(async () => {
              return await execute();
            }, false);
            
            if (result.error) {
              logger.error(`Swap execution failed on retry: ${result.error}`);
              return {
                success: false,
                error: `Swap execution failed on retry: ${result.error}`,
              };
            }
            
            // Extract transaction details
            const txHash = result.txid;
            const outputAmount = Number(bestRoute.outAmount);
            
            // Get approximate USD value
            const outputAmountUsd = amountInSol * 10; // Placeholder
            
            const swapResult = {
              success: true,
              inputAmount: amountInSol,
              outputAmount: outputAmount,
              outputAmountUsd: outputAmountUsd,
              txHash: txHash,
              timestamp: Date.now(),
              provider: 'jupiter-retry-high-slippage'
            };
            
            // Log the trade in database
            await this.logTrade(tokenAddress, swapResult);
            
            logger.info(`Swap executed successfully with high slippage retry: ${swapResult.txHash}`);
            return swapResult;
          } catch (retryError) {
            logger.error(`Jupiter high-slippage retry failed: ${retryError.message}`);
            // Fall through to the error return
          }
          
          return {
            success: false,
            error: 'No routes found',
          };
        }
        
        // Select the best route
        const bestRoute = routes.routesInfos[0];
        logger.info(`Selected route with output: ${bestRoute.outAmount} tokens`);
        
        // Execute the swap with rate limiting
        const { execute } = await this.jupiterRateLimiter.execute(async () => {
          return await jupiterInstance.exchange({
            routeInfo: bestRoute,
          });
        }, false); // Not a Price API call
        
        const result = await this.jupiterRateLimiter.execute(async () => {
          return await execute();
        }, false); // Not a Price API call
        
        if (result.error) {
          logger.error(`Swap execution failed: ${result.error}`);
          return {
            success: false,
            error: result.error,
          };
        }
        
        // Extract transaction details
        const txHash = result.txid;
        const outputAmount = Number(bestRoute.outAmount);
        
        // Get approximate USD value (this is simplified, in a real implementation you'd get the actual price)
        // For now, we'll estimate based on the input amount
        const outputAmountUsd = amountInSol * 10; // Placeholder, replace with actual price data
        
        const swapResult = {
          success: true,
          inputAmount: amountInSol,
          outputAmount: outputAmount,
          outputAmountUsd: outputAmountUsd,
          txHash: txHash,
          timestamp: Date.now(),
          provider: 'jupiter'
        };
        
        // Log the trade in database
        await this.logTrade(tokenAddress, swapResult);
        
        logger.info(`Swap executed successfully: ${swapResult.txHash}`);
        return swapResult;
      } catch (jupiterError) {
        // If Jupiter fails, log the error and try an alternative method
        logger.error(`Jupiter swap failed: ${jupiterError.message}. Trying alternative method...`);
        
        // Check if this is an account info missing error
        if (jupiterError.message.includes('Account info') && jupiterError.message.includes('missing')) {
          // Try with a different RPC endpoint first before falling back to ApeJupiter
          logger.info('Account info missing error detected. Trying with a different RPC endpoint...');
          
          // Rotate to a new RPC endpoint
          const oldEndpoint = this.rpcManager.getCurrentEndpoint();
          this.connection = this.rpcManager.rotateEndpoint();
          logger.info(`Rotated from ${oldEndpoint} to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
          
          // Try again with the new RPC endpoint
          try {
            // Initialize Jupiter with the new connection
            const jupiterInstance = await this.jupiterRateLimiter.execute(async () => {
              return await Jupiter.load({
                connection: this.connection,
                cluster: 'mainnet-beta',
                user: keypair,
                apiKey: this.jupiterRateLimiter.config.apiKey,
              });
            }, false);
            
            // Get routes with rate limiting
            const routes = await this.jupiterRateLimiter.execute(async () => {
              return await jupiterInstance.computeRoutes({
                inputMint: new PublicKey('So11111111111111111111111111111111111111112'),
                outputMint: new PublicKey(tokenAddress),
                amount: amountInLamports,
                slippageBps: Math.floor(slippageToUse * 100),
                forceFetch: true, // Force fetch fresh data
              });
            }, false);
            
            if (!routes.routesInfos || routes.routesInfos.length === 0) {
              logger.error(`No routes found for swap from SOL to ${tokenAddress} with new RPC endpoint`);
              // Continue to ApeJupiter fallback
            } else {
              // Select the best route
              const bestRoute = routes.routesInfos[0];
              logger.info(`Selected route with output: ${bestRoute.outAmount} tokens`);
              
              // Execute the swap with rate limiting
              const { execute } = await this.jupiterRateLimiter.execute(async () => {
                return await jupiterInstance.exchange({
                  routeInfo: bestRoute,
                });
              }, false);
              
              const result = await this.jupiterRateLimiter.execute(async () => {
                return await execute();
              }, false);
              
              if (result.error) {
                logger.error(`Swap execution failed with new RPC endpoint: ${result.error}`);
                // Continue to ApeJupiter fallback
              } else {
                // Extract transaction details
                const txHash = result.txid;
                const outputAmount = Number(bestRoute.outAmount);
                
                // Get approximate USD value
                const outputAmountUsd = amountInSol * 10; // Placeholder
                
                const swapResult = {
                  success: true,
                  inputAmount: amountInSol,
                  outputAmount: outputAmount,
                  outputAmountUsd: outputAmountUsd,
                  txHash: txHash,
                  timestamp: Date.now(),
                  provider: 'jupiter-retry'
                };
                
                // Log the trade in database
                await this.logTrade(tokenAddress, swapResult);
                
                logger.info(`Swap executed successfully with new RPC endpoint: ${swapResult.txHash}`);
                return swapResult;
              }
            }
          } catch (retryError) {
            logger.error(`Jupiter retry with new RPC endpoint failed: ${retryError.message}`);
            // Continue to Jupiter API fallback
          }
        }
        
        // Check if this is a rate limit error
        if (jupiterError.message.includes('429') || jupiterError.message.includes('Too Many Requests')) {
          logger.warn('Rate limit detected, cooling down Jupiter API requests');
          // Force a cooldown period
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // Try rotating the RPC endpoint
          this.connection = this.rpcManager.rotateEndpoint();
          logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
        }
        
        // Try using the Jupiter API directly as a fallback
        try {
          logger.info(`Trying Jupiter API directly as fallback for swap: ${tokenAddress}`);
          return await this.executeJupiterApiSwap(tokenAddress, amountInSol, slippageToUse);
        } catch (jupiterApiError) {
          logger.error(`Jupiter API fallback swap failed: ${jupiterApiError.message}`);
          // Continue to next fallback
        }
        
          // If we have a Raydium fallback, try it next (prioritize Raydium over ApeJupiter)
        if (this.hasRaydiumFallback) {
          try {
            // Check if this is one of our special tokens that need Raydium
            const forceRaydiumTokens = [
              'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN', // CAT  
              'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU', // DOG
              'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv',  // LOL
            ];
            
            // Use token-specific slippage if available, otherwise use higher slippage
            let adjustedSlippage = slippageToUse;
            
            // Token-specific fallback slippage settings
            if (tokenAddress === 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv') {
              // LOL token - use higher slippage for fallback
              adjustedSlippage = 10.0; // 10% max slippage for fallback
              logger.info(`Using token-specific fallback slippage of ${adjustedSlippage}% for LOL token (Raydium)`);
            } else if (tokenAddress === 'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN') {
              // CAT token
              adjustedSlippage = 15.0; // 15% max slippage for fallback
              logger.info(`Using token-specific fallback slippage of ${adjustedSlippage}% for CAT token (Raydium)`);
            } else if (tokenAddress === 'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU') {
              // DOG token
              adjustedSlippage = 15.0; // 15% max slippage for fallback
              logger.info(`Using token-specific fallback slippage of ${adjustedSlippage}% for DOG token (Raydium)`);
            } else if (forceRaydiumTokens.includes(tokenAddress)) {
              adjustedSlippage = Math.max(slippageToUse, 10.0); // At least 10% slippage for special tokens
              logger.info(`Using higher slippage (${adjustedSlippage}%) for special token ${tokenAddress} with Raydium`);
            }
            
            logger.info(`Trying Raydium direct integration as fallback for swap: ${tokenAddress}`);
            const raydiumResult = await this._executeRaydiumDirectly(tokenAddress, amountInLamports, adjustedSlippage, keypair);
            if (raydiumResult && raydiumResult.success) {
              return raydiumResult;
            } else {
              logger.error(`Raydium fallback swap failed: ${raydiumResult?.error || 'Unknown error'}`);
              // Continue to next fallback
            }
          } catch (raydiumError) {
            logger.error(`Raydium fallback swap failed: ${raydiumError.message}`);
            // Continue to next fallback
          }
        }
        
        // If ApeJupiter is enabled but we didn't try it yet (not a memecoin), try it as a fallback
        if (this.useApeJupiter && !isMemeToken) {
          try {
            logger.info(`Trying ApeJupiter as fallback for swap: ${tokenAddress}`);
            return await this._executeApeJupiterSwap(tokenAddress, amountInLamports, slippageToUse, keypair);
          } catch (apeError) {
            logger.error(`ApeJupiter fallback swap failed: ${apeError.message}`);
            // Continue to next fallback
          }
        }
        
        // If we have a PumpSwap fallback, try it
        if (this.hasPumpSwapFallback) {
          try {
            logger.info(`Trying PumpSwap as fallback for swap: ${tokenAddress}`);
            return await this._executePumpSwapDirectly(tokenAddress, amountInLamports, slippageToUse, keypair);
          } catch (pumpSwapError) {
            logger.error(`PumpSwap fallback swap failed: ${pumpSwapError.message}`);
            // Continue to next fallback
          }
        }
        
        // If we've tried all available methods and they all failed, try one more time with higher slippage
        try {
          logger.info(`Trying one final attempt with very high slippage (60%): ${tokenAddress}`);
          // Always get the latest connection from the RPC manager
          this.connection = this.rpcManager.getCurrentConnection();
          
          // Initialize Jupiter with rate limiting
          const jupiterInstance = await this.jupiterRateLimiter.execute(async () => {
            return await Jupiter.load({
              connection: this.connection,
              cluster: 'mainnet-beta',
              user: keypair,
              apiKey: this.jupiterRateLimiter.config.apiKey, // Use API key from rate limiter
            });
          }, false);
          
          // Define input and output tokens
          const inputMint = new PublicKey('So11111111111111111111111111111111111111112'); // SOL
          const outputMint = new PublicKey(tokenAddress); // Target token
          
          // Get routes with rate limiting and very high slippage
          const routes = await this.jupiterRateLimiter.execute(async () => {
            return await jupiterInstance.computeRoutes({
              inputMint,
              outputMint,
              amount: amountInLamports,
              slippageBps: 6000, // 60% slippage as last resort
              forceFetch: true, // Force fetch fresh data
            });
          }, false);
          
          if (!routes.routesInfos || routes.routesInfos.length === 0) {
            logger.error(`No routes found even with 60% slippage. Giving up.`);
          } else {
            // Found routes with high slippage!
            const bestRoute = routes.routesInfos[0];
            logger.info(`Found route with high slippage, output: ${bestRoute.outAmount} tokens`);
            
            // Execute the swap with rate limiting
            const { execute } = await this.jupiterRateLimiter.execute(async () => {
              return await jupiterInstance.exchange({
                routeInfo: bestRoute,
              });
            }, false);
            
            const result = await this.jupiterRateLimiter.execute(async () => {
              return await execute();
            }, false);
            
            if (result.error) {
              logger.error(`High slippage swap execution failed: ${result.error}`);
            } else {
              // Extract transaction details
              const txHash = result.txid;
              const outputAmount = Number(bestRoute.outAmount);
              
              // Get approximate USD value
              const outputAmountUsd = amountInSol * 10; // Placeholder
              
              const swapResult = {
                success: true,
                inputAmount: amountInSol,
                outputAmount: outputAmount,
                outputAmountUsd: outputAmountUsd,
                txHash: txHash,
                timestamp: Date.now(),
                provider: 'jupiter-high-slippage'
              };
              
              // Log the trade in database
              await this.logTrade(tokenAddress, swapResult);
              
              logger.info(`Swap executed successfully with high slippage: ${swapResult.txHash}`);
              return swapResult;
            }
          }
        } catch (highSlippageError) {
          logger.error(`High slippage attempt failed: ${highSlippageError.message}`);
          // Continue to error handling
        }
        
        // For now, we'll return an error
        return {
          success: false,
          error: `Jupiter swap failed: ${jupiterError.message}`,
        };
      }
    } catch (error) {
      logger.error(`Error executing swap: ${error.message}`);
      
      // If we encounter an RPC-related error, try rotating the endpoint
      if (error.message.includes('429') || 
          error.message.includes('timeout') || 
          error.message.includes('connection') ||
          error.message.includes('network')) {
        logger.info('Detected RPC issue, rotating endpoint...');
        this.connection = this.rpcManager.rotateEndpoint();
        logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
      }
      
      return {
        success: false,
        error: error.message,
      };
    }
  }
  
  /**
   * Execute a swap using ApeJupiter
   * @private
   */
  async _executeApeJupiterSwap(tokenAddress, amountInLamports, slippagePercentage, keypair) {
    try {
      logger.info(`Executing ApeJupiter swap for ${tokenAddress} with ${amountInLamports / 1e9} SOL`);
      
      // Convert slippage percentage to basis points
      const slippageBps = Math.floor(slippagePercentage * 100);
      
      // Define input and output tokens
      const inputMint = 'So11111111111111111111111111111111111111112'; // SOL
      const outputMint = tokenAddress; // Target token
      
      // Get quote from ApeJupiter
      logger.info(`Getting ApeJupiter quote for ${inputMint} -> ${outputMint}, amount: ${amountInLamports}, slippage: ${slippageBps} bps`);
      let quote;
      try {
        quote = await apeJupiterClient.getQuote(
          inputMint,
          outputMint,
          amountInLamports,
          slippageBps
        );
      } catch (quoteError) {
        logger.error(`Error getting ApeJupiter quote: ${quoteError.message}`);
        
        // Try with a higher slippage if the first attempt fails
        if (slippageBps < 2500) { // If less than 25%
          logger.info(`Retrying ApeJupiter quote with higher slippage (25%)`);
          try {
            quote = await apeJupiterClient.getQuote(
              inputMint,
              outputMint,
              amountInLamports,
              2500 // 25% slippage
            );
          } catch (retryError) {
            logger.error(`Retry with higher slippage also failed: ${retryError.message}`);
            throw new Error(`Failed to get ApeJupiter quote: ${quoteError.message}`);
          }
        } else {
          throw new Error(`Failed to get ApeJupiter quote: ${quoteError.message}`);
        }
      }
      
      if (!quote || !quote.outAmount) {
        throw new Error('Invalid quote response from ApeJupiter');
      }
      
      // Generate swap transaction
      let swapResponse;
      try {
        swapResponse = await apeJupiterClient.getSwapTransaction(
          quote,
          keypair.publicKey.toString()
        );
      } catch (txError) {
        logger.error(`Error getting ApeJupiter swap transaction: ${txError.message}`);
        throw new Error(`Failed to get swap transaction: ${txError.message}`);
      }
      
      if (!swapResponse || !swapResponse.transaction) {
        throw new Error('Invalid swap transaction response from ApeJupiter');
      }
      
      // Sign and send the transaction
      const transaction = swapResponse.transaction;
      
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      
      // Sign and send the transaction
      let txid;
      try {
        txid = await sendAndConfirmTransaction(
          this.connection,
          transaction,
          [keypair]
        );
      } catch (sendError) {
        logger.error(`Error sending ApeJupiter transaction: ${sendError.message}`);
        
        // If we encounter an RPC-related error, try rotating the endpoint and retry
        if (sendError.message.includes('timeout') || 
            sendError.message.includes('connection') ||
            sendError.message.includes('network') ||
            sendError.message.includes('block height') ||
            sendError.message.includes('blockhash')) {
          
          logger.info('Transaction send failed. Rotating RPC endpoint and retrying...');
          this.connection = this.rpcManager.rotateEndpoint();
          logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
          
          // Retry with new connection
          try {
            // Need to get a new transaction with fresh blockhash
            logger.info('Getting fresh swap transaction with new blockhash...');
            swapResponse = await apeJupiterClient.getSwapTransaction(
              quote,
              keypair.publicKey.toString()
            );
            
            if (!swapResponse || !swapResponse.transaction) {
              throw new Error('Invalid swap transaction on retry');
            }
            
            txid = await sendAndConfirmTransaction(
              this.connection,
              swapResponse.transaction,
              [keypair]
            );
            
            logger.info(`Transaction sent successfully on retry: ${txid}`);
          } catch (retryError) {
            logger.error(`Retry also failed: ${retryError.message}`);
            throw new Error(`Failed to send transaction after retry: ${retryError.message}`);
          }
        } else {
          throw new Error(`Failed to send transaction: ${sendError.message}`);
        }
      }
      
      // Extract output amount from quote
      const outputAmount = Number(quote.outAmount);
      
      // Get approximate USD value (this is simplified)
      const outputAmountUsd = (amountInLamports / 1e9) * 10; // Placeholder
      
      const swapResult = {
        success: true,
        inputAmount: amountInLamports / 1e9, // Convert back to SOL
        outputAmount: outputAmount,
        outputAmountUsd: outputAmountUsd,
        txHash: txid,
        timestamp: Date.now(),
        provider: 'apeJupiter'
      };
      
      // Log the trade in database
      await this.logTrade(tokenAddress, swapResult);
      
      logger.info(`ApeJupiter swap executed successfully: ${swapResult.txHash}`);
      return swapResult;
    } catch (error) {
      logger.error(`Error executing ApeJupiter swap: ${error.message}`);
      
      // If we encounter an RPC-related error, try rotating the endpoint
      if (error.message.includes('429') || 
          error.message.includes('timeout') || 
          error.message.includes('connection') ||
          error.message.includes('network')) {
        logger.info('Detected RPC issue, rotating endpoint...');
        this.connection = this.rpcManager.rotateEndpoint();
        logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
      }
      
      throw error; // Propagate the error to be handled by the caller
    }
  }

  /**
   * Execute a swap for LOL token specifically
   * This method is optimized for the LOL token based on transaction analysis
   * @param {number} amountInSol - Amount of SOL to swap
   * @param {number} slippage - Slippage percentage
   * @returns {Promise<Object>} - Swap result
   */
  async executeLolTokenSwap(amountInSol, slippage = null) {
    const LOL_TOKEN_ADDRESS = 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv';
    
    try {
      logger.info(`Executing optimized LOL token swap with ${amountInSol} SOL`);
      
      // Define LOL-specific slippage settings
      const lolSettings = {
        defaultSlippage: 1.0,
        minSlippage: 1.0,
        maxSlippage: 10.0,
        preferredDex: 'Raydium'
      };
      
      // Use provided slippage or default from settings
      const slippageToUse = slippage || lolSettings.defaultSlippage;
      logger.info(`Using ${slippageToUse}% slippage for LOL token swap`);
      
      // Check if trading is enabled
      if (!config.trading.enabled) {
        logger.info(`Trading is disabled, skipping LOL token swap`);
        return { success: false, error: 'Trading is disabled' };
      }
      
      // Get wallet balance
      const walletBalance = await this.getWalletBalance();
      if (walletBalance < amountInSol) {
        logger.error(`Insufficient balance: ${walletBalance} SOL, needed ${amountInSol} SOL`);
        return {
          success: false,
          error: 'Insufficient balance',
        };
      }
      
      // Get the keypair
      const keypair = wallet.getKeypair();
      
      // Convert SOL to lamports
      const amountInLamports = Math.floor(amountInSol * 1e9);
      
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      
      // Make sure Raydium client has the connection
      if (raydiumClient.setConnection) {
        raydiumClient.setConnection(this.connection);
      }
      
      // Execute Raydium swap directly
      logger.info(`Executing direct Raydium swap for LOL token with ${amountInSol} SOL (${slippageToUse}% slippage)`);
      return await this._executeRaydiumDirectly(LOL_TOKEN_ADDRESS, amountInLamports, slippageToUse, keypair);
    } catch (error) {
      logger.error(`Error executing LOL token swap: ${error.message}`);
      return { success: false, error: `LOL token swap failed: ${error.message}` };
    }
  }
  
  async executeSell(tokenAddress, amountIn, slippage = null) {
    try {
      const slippageToUse = slippage || this.defaultSlippage;
      logger.info(`Executing sell for token ${tokenAddress} with amount ${amountIn} (slippage: ${slippageToUse}%)`);
      
      // Special tokens that need direct Raydium execution
      const forceRaydiumTokens = [
        'CXc5JcEJkFJUX6Mtrti7BXPUQrgL7oj23D6pUGG3cbeN', // CAT  
        'AU3muMMYmSAG9th4JVgRRpiU4xPzWyYgBh6sGJRahaiU', // DOG
        'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv',  // LOL
      ];
      
      // Check if this is a special token that needs Raydium
      if (forceRaydiumTokens.includes(tokenAddress) || 
          (raydiumClient.shouldForceRaydium && raydiumClient.shouldForceRaydium(tokenAddress))) {
        logger.info(`Force using Raydium direct integration for selling ${tokenAddress}`);
        
        // Get the keypair
        const keypair = wallet.getKeypair();
        
        // Use token-specific slippage if available, otherwise use higher slippage
        let adjustedSlippage = slippageToUse;
        if (tokenSlippageSettings[tokenAddress]) {
          const settings = tokenSlippageSettings[tokenAddress];
          // Use max slippage for selling to ensure execution
          adjustedSlippage = settings.maxSlippage;
          logger.info(`Using token-specific slippage of ${adjustedSlippage}% for selling ${tokenAddress}`);
        } else {
          adjustedSlippage = Math.max(slippageToUse, 10.0); // At least 10% slippage
          logger.info(`Using higher slippage (${adjustedSlippage}%) for special token ${tokenAddress} with Raydium`);
        }
        
        try {
          // Try to execute a direct Raydium sell
          // Note: This is a simplified approach - in reality, selling tokens via Raydium directly
          // would require a different implementation than buying
          const amountInLamports = Math.floor(amountIn * 1e9); // This is a simplification
          return await this._executeRaydiumDirectly(tokenAddress, amountInLamports, adjustedSlippage, keypair);
        } catch (raydiumError) {
          logger.error(`Raydium direct sell failed: ${raydiumError.message}. Falling back to Jupiter.`);
          // Continue with standard execution path
        }
      }
      
      // Check if trading is enabled
      if (!process.env.TRADING_ENABLED || process.env.TRADING_ENABLED.toLowerCase() !== 'true') {
        logger.warn('Trading is disabled. Set TRADING_ENABLED=true to enable real trading.');
        return {
          success: false,
          error: 'Trading is disabled',
        };
      }
      
      // Check for active trading pairs using DexScreener if enabled
      if (this.useDexScreener) {
        try {
          logger.info(`Checking DexScreener for active pairs for token: ${tokenAddress}`);
          const dexScreenerResult = await dexScreenerClient.checkActivePairs(tokenAddress, {
            requireVerifiedPair: this.requireVerifiedPair,
            minLiquidityUsd: this.dexScreenerMinLiquidity,
            minVolumeUsd: this.dexScreenerMinVolume,
            preferredDexes: this.preferredDexes
          });
          
          if (!dexScreenerResult.hasActivePairs) {
            logger.error(`No active trading pairs found for token ${tokenAddress} on DexScreener. Aborting sell.`);
            return {
              success: false,
              error: 'No active trading pairs found on DexScreener',
              dexScreenerResult
            };
          }
          
          // Check if we require Jupiter-compatible pairs
          if (this.requireJupiterCompatiblePair && !dexScreenerResult.hasJupiterCompatiblePairs) {
            logger.error(`No Jupiter-compatible trading pairs found for token ${tokenAddress}. Aborting sell.`);
            return {
              success: false,
              error: 'No Jupiter-compatible trading pairs found',
              dexScreenerResult
            };
          }
          
          // Get detailed DEX information to help with routing
          const dexInfo = await dexScreenerClient.getTokenDexInfo(tokenAddress);
          
          // Log the best pair information
          if (dexScreenerResult.bestPair) {
            const bestPair = dexScreenerResult.bestPair;
            logger.info(`Found active trading pair on ${bestPair.dexId} with ${bestPair.liquidity?.usd} liquidity and ${bestPair.volume?.h24} 24h volume`);
          }
          
          // Store DEX info for use during swap execution
          this.currentTokenDexInfo = dexInfo;
          
          if (dexInfo.jupiterCompatibleDexes.length > 0) {
            logger.info(`Jupiter-compatible DEXes for ${tokenAddress}: ${dexInfo.jupiterCompatibleDexes.join(', ')}`);
          }
        } catch (dexScreenerError) {
          // Log the error but continue with the sell
          logger.warn(`Error checking DexScreener: ${dexScreenerError.message}. Continuing with sell anyway.`);
          this.currentTokenDexInfo = null;
        }
      } else {
        this.currentTokenDexInfo = null;
      }
      
      // Get the keypair
      const keypair = wallet.getKeypair();
      
      // Check if this is a memecoin and if we should use ApeJupiter
      let isMemeToken = false;
      if (this.useApeJupiter) {
        try {
          isMemeToken = await apeJupiterClient.isMemeToken(tokenAddress);
          logger.info(`Token ${tokenAddress} is ${isMemeToken ? 'a memecoin' : 'not a memecoin'}`);
        } catch (error) {
          logger.warn(`Error checking if token is a memecoin: ${error.message}. Will use standard Jupiter.`);
        }
      }
      
      // If this is a memecoin and ApeJupiter is enabled, use it
      if (this.useApeJupiter && isMemeToken) {
        try {
          logger.info(`Using ApeJupiter for memecoin sell: ${tokenAddress}`);
          return await this._executeApeJupiterSell(tokenAddress, amountIn, slippageToUse, keypair);
        } catch (apeError) {
          logger.error(`ApeJupiter sell failed: ${apeError.message}`);
          
          // If fallback is enabled, try regular Jupiter
          if (this.fallbackToJupiter) {
            logger.info(`Falling back to regular Jupiter for sell`);
            // Continue to regular Jupiter execution below
          } else {
            // If no fallback, return the error
            return {
              success: false,
              error: `ApeJupiter sell failed: ${apeError.message}`,
            };
          }
        }
      }
      
      // Check if we should use Jupiter API directly (if preferred)
      if (this.useJupiterApi && this.preferJupiterApi) {
        try {
          logger.info(`Using Jupiter API directly for sell: ${tokenAddress}`);
          return await this.executeJupiterApiSell(tokenAddress, amountIn, slippageToUse);
        } catch (jupiterApiError) {
          logger.error(`Jupiter API direct sell failed: ${jupiterApiError.message}. Falling back to SDK.`);
          // Continue to standard Jupiter SDK execution below
        }
      }
      
      // Standard Jupiter execution path
      try {
        // Always get the latest connection from the RPC manager
        this.connection = this.rpcManager.getCurrentConnection();
        
        // Initialize Jupiter with rate limiting
        const jupiterInstance = await this.jupiterRateLimiter.execute(async () => {
          return await Jupiter.load({
            connection: this.connection,
            cluster: 'mainnet-beta',
            user: keypair,
            apiKey: this.jupiterRateLimiter.config.apiKey, // Use API key from rate limiter
          });
        }, false); // Not a Price API call
        
        // Define input and output tokens
        const inputMint = new PublicKey(tokenAddress); // Token to sell
        const outputMint = new PublicKey('So11111111111111111111111111111111111111112'); // SOL
        
        // Get routes with rate limiting
        const routes = await this.jupiterRateLimiter.execute(async () => {
          return await jupiterInstance.computeRoutes({
            inputMint,
            outputMint,
            amount: amountIn,
            slippageBps: Math.floor(slippageToUse * 100), // Convert percentage to basis points
          });
        }, false); // Not a Price API call
        
        if (!routes.routesInfos || routes.routesInfos.length === 0) {
          logger.error(`No routes found for swap from ${tokenAddress} to SOL`);
          
          // If Jupiter API is enabled, try it as a fallback
          if (this.useJupiterApi && !this.preferJupiterApi) {
            logger.info(`No Jupiter SDK routes found. Trying Jupiter API as fallback for sell: ${tokenAddress}`);
            try {
              return await this.executeJupiterApiSell(tokenAddress, amountIn, slippageToUse);
            } catch (jupiterApiError) {
              logger.error(`Jupiter API fallback sell failed: ${jupiterApiError.message}`);
              // Continue to error handling
            }
          }
          
          return {
            success: false,
            error: 'No routes found',
          };
        }
        
        // Select the best route
        const bestRoute = routes.routesInfos[0];
        logger.info(`Selected route with output: ${bestRoute.outAmount} lamports`);
        
        // Execute the swap with rate limiting
        const { execute } = await this.jupiterRateLimiter.execute(async () => {
          return await jupiterInstance.exchange({
            routeInfo: bestRoute,
          });
        }, false); // Not a Price API call
        
        const result = await this.jupiterRateLimiter.execute(async () => {
          return await execute();
        }, false); // Not a Price API call
        
        if (result.error) {
          logger.error(`Sell execution failed: ${result.error}`);
          return {
            success: false,
            error: result.error,
          };
        }
        
        // Extract transaction details
        const txHash = result.txid;
        const outputAmountLamports = Number(bestRoute.outAmount);
        const outputAmountSol = outputAmountLamports / 1e9; // Convert lamports to SOL
        
        // Get approximate USD value (this is simplified, in a real implementation you'd get the actual price)
        const outputAmountUsd = outputAmountSol * 100; // Placeholder, replace with actual price data
        
        const sellResult = {
          success: true,
          inputAmount: amountIn,
          outputAmountSol: outputAmountSol,
          outputAmountUsd: outputAmountUsd,
          txHash: txHash,
          timestamp: Date.now(),
          provider: 'jupiter'
        };
        
        // Update the trade in database
        await this.updateTradeOnSell(tokenAddress, sellResult);
        
        logger.info(`Sell executed successfully: ${sellResult.txHash}`);
        return sellResult;
      } catch (jupiterError) {
        // If Jupiter fails, log the error and try an alternative method
        logger.error(`Jupiter sell failed: ${jupiterError.message}. Trying alternative method...`);
        
        // Check if this is a rate limit error
        if (jupiterError.message.includes('429') || jupiterError.message.includes('Too Many Requests')) {
          logger.warn('Rate limit detected, cooling down Jupiter API requests');
          // Force a cooldown period
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // Try rotating the RPC endpoint
          this.connection = this.rpcManager.rotateEndpoint();
          logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
        }
        
        // Try using the Jupiter API directly as a fallback
        try {
          logger.info(`Trying Jupiter API directly as fallback for sell: ${tokenAddress}`);
          return await this.executeJupiterApiSell(tokenAddress, amountIn, slippageToUse);
        } catch (jupiterApiError) {
          logger.error(`Jupiter API fallback sell failed: ${jupiterApiError.message}`);
          // Continue to ApeJupiter fallback
        }
        
        // If ApeJupiter is enabled but we didn't try it yet (not a memecoin), try it as a fallback
        if (this.useApeJupiter && !isMemeToken) {
          try {
            logger.info(`Trying ApeJupiter as fallback for sell: ${tokenAddress}`);
            return await this._executeApeJupiterSell(tokenAddress, amountIn, slippageToUse, keypair);
          } catch (apeError) {
            logger.error(`ApeJupiter fallback sell failed: ${apeError.message}`);
            // Continue to Raydium fallback
          }
        }
        
        // Try Raydium as a last resort fallback
        try {
          logger.info(`Trying Raydium as final fallback for sell: ${tokenAddress}`);
          // Convert token amount to equivalent SOL amount for the Raydium sell
          const amountInLamports = Math.floor(amountIn * 1e9); // This is a simplification
          return await this._executeRaydiumDirectly(tokenAddress, amountInLamports, slippageToUse, keypair);
        } catch (raydiumError) {
          logger.error(`Raydium fallback sell failed: ${raydiumError.message}`);
          // Continue to error handling
        }
        
        // For now, we'll return an error
        return {
          success: false,
          error: `Jupiter sell failed: ${jupiterError.message}`,
        };
      }
    } catch (error) {
      logger.error(`Error executing sell: ${error.message}`);
      
      // If we encounter an RPC-related error, try rotating the endpoint
      if (error.message.includes('429') || 
          error.message.includes('timeout') || 
          error.message.includes('connection') ||
          error.message.includes('network')) {
        logger.info('Detected RPC issue, rotating endpoint...');
        this.connection = this.rpcManager.rotateEndpoint();
        logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
      }
      
      return {
        success: false,
        error: error.message,
      };
    }
  }
  
  /**
   * Execute a sell using ApeJupiter
   * @private
   */
  async _executeApeJupiterSell(tokenAddress, amountIn, slippagePercentage, keypair) {
    try {
      logger.info(`Executing ApeJupiter sell for ${tokenAddress} with amount ${amountIn}`);
      
      // Convert slippage percentage to basis points
      const slippageBps = Math.floor(slippagePercentage * 100);
      
      // Define input and output tokens
      const inputMint = tokenAddress; // Token to sell
      const outputMint = 'So11111111111111111111111111111111111111112'; // SOL
      
      // Get quote from ApeJupiter
      const quote = await apeJupiterClient.getQuote(
        inputMint,
        outputMint,
        amountIn,
        slippageBps
      );
      
      // Generate swap transaction
      const swapResponse = await apeJupiterClient.getSwapTransaction(
        quote,
        keypair.publicKey.toString()
      );
      
      // Sign and send the transaction
      const transaction = swapResponse.transaction;
      
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      
      // Sign and send the transaction
      const txid = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [keypair]
      );
      
      // Extract output amount from quote
      const outputAmountLamports = Number(quote.outAmount);
      const outputAmountSol = outputAmountLamports / 1e9; // Convert lamports to SOL
      
      // Get approximate USD value (this is simplified)
      const outputAmountUsd = outputAmountSol * 100; // Placeholder
      
      const sellResult = {
        success: true,
        inputAmount: amountIn,
        outputAmountSol: outputAmountSol,
        outputAmountUsd: outputAmountUsd,
        txHash: txid,
        timestamp: Date.now(),
        provider: 'apeJupiter'
      };
      
      // Update the trade in database
      await this.updateTradeOnSell(tokenAddress, sellResult);
      
      logger.info(`ApeJupiter sell executed successfully: ${sellResult.txHash}`);
      return sellResult;
    } catch (error) {
      logger.error(`Error executing ApeJupiter sell: ${error.message}`);
      
      // If we encounter an RPC-related error, try rotating the endpoint
      if (error.message.includes('429') || 
          error.message.includes('timeout') || 
          error.message.includes('connection') ||
          error.message.includes('network')) {
        logger.info('Detected RPC issue, rotating endpoint...');
        this.connection = this.rpcManager.rotateEndpoint();
        logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
      }
      
      throw error; // Propagate the error to be handled by the caller
    }
  }

  async getWalletBalance() {
    try {
      const publicKey = wallet.getKeypair().publicKey;
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      const balance = await this.connection.getBalance(publicKey);
      return balance / 1e9; // Convert lamports to SOL
    } catch (error) {
      logger.error(`Error getting wallet balance: ${error.message}`);
      return 0;
    }
  }

  /**
   * Gets the current Jupiter rate limiter status
   */
  getJupiterRateLimiterStatus() {
    return this.jupiterRateLimiter.getStatus();
  }

  /**
   * Gets the current RPC endpoint status
   */
  getRpcEndpointStatus() {
    return this.rpcManager.getEndpointMetrics();
  }
  
  /**
   * Execute a swap directly using PumpSwap
   * @param {string} tokenAddress - The token address to swap to
   * @param {number} amountInSol - The amount in SOL to swap
   * @param {number} slippage - The slippage percentage to use
   * @returns {Promise<Object>} - The swap result
   */
  /**
   * Execute a swap directly using Raydium
   * @param {string} tokenAddress - The token address to swap to
   * @param {number} amountInLamports - The amount in lamports to swap
   * @param {number} slippagePercentage - The slippage percentage to use
   * @param {Keypair} keypair - The wallet keypair
   * @returns {Promise<Object>} - The swap result
   * @private
   */
  async _executeRaydiumDirectly(tokenAddress, amountInLamports, slippagePercentage, keypair) {
    try {
      logger.info(`Executing Raydium direct swap for ${tokenAddress} with ${amountInLamports / 1e9} SOL`);
      
      // Convert slippage percentage to basis points
      const slippageBps = Math.floor(slippagePercentage * 100);
      
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      
      // Make sure Raydium client has the connection
      if (typeof raydiumClient.setConnection === 'function') {
        raydiumClient.setConnection(this.connection);
      }
      
      // Special handling for LOL token - use higher slippage
      let adjustedSlippageBps = slippageBps;
      if (tokenAddress === 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv') {
        adjustedSlippageBps = Math.max(slippageBps, 1000); // At least 10% slippage for LOL token
        logger.info(`Using higher slippage (${adjustedSlippageBps / 100}%) for LOL token`);
      }
      
      // Execute the swap using the Raydium client
      const result = await raydiumClient.executeSwap(tokenAddress, amountInLamports, adjustedSlippageBps / 100, keypair);
      
      if (!result.success) {
        throw new Error(result.error || 'Raydium swap failed');
      }
      
      // Create the result object
      const swapResult = {
        success: true,
        inputAmount: amountInLamports / 1e9, // Convert back to SOL
        outputAmount: result.outputAmount,
        outputAmountUsd: (amountInLamports / 1e9) * 10, // Simplified USD calculation
        txHash: result.signature,
        timestamp: Date.now(),
        provider: 'raydium-direct'
      };
      
      // Log the trade in database
      await this.logTrade(tokenAddress, swapResult);
      
      logger.info(`Raydium swap executed successfully: ${swapResult.txHash}`);
      return swapResult;
    } catch (error) {
      logger.error(`Error executing Raydium swap: ${error.message}`);
      
      // If we encounter an RPC-related error, try rotating the endpoint and retry once
      if (error.message.includes('429') || 
          error.message.includes('timeout') || 
          error.message.includes('connection') ||
          error.message.includes('network') ||
          error.message.includes('failed to fetch') ||
          error.message.includes('failed to send') ||
          error.message.includes('blockhash') ||
          error.message.includes('not confirmed') ||
          error.message.includes('transaction simulation failed')) {
        logger.info('Detected RPC issue, rotating endpoint and retrying...');
        this.connection = this.rpcManager.rotateEndpoint();
        logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
        
        // Make sure Raydium client has the new connection
        if (typeof raydiumClient.setConnection === 'function') {
          raydiumClient.setConnection(this.connection);
        }
        
        // Retry with new connection
        try {
          logger.info(`Retrying Raydium swap with new RPC endpoint...`);
          
          // Special handling for LOL token - use higher slippage
          let adjustedSlippageBps = Math.floor(slippagePercentage * 100);
          if (tokenAddress === 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv') {
            adjustedSlippageBps = Math.max(adjustedSlippageBps, 1000); // At least 10% slippage for LOL token
            logger.info(`Using higher slippage (${adjustedSlippageBps / 100}%) for LOL token on retry`);
          }
          
          // Execute the swap using the Raydium client with new connection
          const result = await raydiumClient.executeSwap(tokenAddress, amountInLamports, adjustedSlippageBps / 100, keypair);
          
          if (!result.success) {
            throw new Error(result.error || 'Raydium swap failed on retry');
          }
          
          // Create the result object
          const swapResult = {
            success: true,
            inputAmount: amountInLamports / 1e9, // Convert back to SOL
            outputAmount: result.outputAmount,
            outputAmountUsd: (amountInLamports / 1e9) * 10, // Simplified USD calculation
            txHash: result.signature,
            timestamp: Date.now(),
            provider: 'raydium-direct-retry'
          };
          
          // Log the trade in database
          await this.logTrade(tokenAddress, swapResult);
          
          logger.info(`Raydium swap executed successfully on retry: ${swapResult.txHash}`);
          return swapResult;
        } catch (retryError) {
          logger.error(`Raydium swap retry failed: ${retryError.message}`);
          throw new Error(`Raydium swap failed after retry: ${retryError.message}`);
        }
      }
      
      throw error; // Propagate the error to be handled by the caller
    }
  }

  async executeRaydiumDirectly(tokenAddress, amountInSol, slippage = null) {
    try {
      logger.info(`Executing direct Raydium swap for ${tokenAddress} with ${amountInSol} SOL`);
      
      // Validate input parameters
      if (!tokenAddress) {
        throw new Error('Token address is required');
      }
      
      if (!amountInSol || amountInSol <= 0) {
        throw new Error('Amount must be greater than 0');
      }
      
      if (amountInSol > this.maxTradeSizeSol) {
        throw new Error(`Amount exceeds maximum trade size of ${this.maxTradeSizeSol} SOL`);
      }
      
      // Convert SOL to lamports
      const amountInLamports = Math.floor(amountInSol * 1e9);
      
      // Use provided slippage or default
      const slippageToUse = slippage !== null ? slippage : this.defaultSlippage;
      
      // Get the keypair
      const keypair = wallet.getKeypair();
      
      // Execute the swap
      return await this._executeRaydiumDirectly(tokenAddress, amountInLamports, slippageToUse, keypair);
    } catch (error) {
      logger.error(`Error executing Raydium swap: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute a swap directly using PumpSwap
   * @param {string} tokenAddress - The token address to swap to
   * @param {number} amountInSol - The amount in SOL to swap
   * @param {number} slippage - The slippage percentage to use
   * @returns {Promise<Object>} - The swap result
   */
  async executePumpSwapDirectly(tokenAddress, amountInSol, slippage = null) {
    try {
      logger.info(`Executing direct PumpSwap swap for ${tokenAddress} with ${amountInSol} SOL`);
      
      // Validate input parameters
      if (!tokenAddress) {
        throw new Error('Token address is required');
      }
      
      if (!amountInSol || amountInSol <= 0) {
        throw new Error('Amount must be greater than 0');
      }
      
      if (amountInSol > this.maxTradeSizeSol) {
        throw new Error(`Amount exceeds maximum trade size of ${this.maxTradeSizeSol} SOL`);
      }
      
      // Convert SOL to lamports
      const amountInLamports = Math.floor(amountInSol * 1e9);
      
      // Use provided slippage or default
      const slippageToUse = slippage !== null ? slippage : this.defaultSlippage;
      
      // Get the keypair
      const keypair = wallet.getKeypair();
      
      // Execute the swap
      return await this._executePumpSwapDirectly(tokenAddress, amountInLamports, slippageToUse, keypair);
    } catch (error) {
      logger.error(`Error executing PumpSwap swap: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Execute a swap directly using PumpSwap
   * @param {string} tokenAddress - The token address to swap to
   * @param {number} amountInLamports - The amount in lamports to swap
   * @param {number} slippagePercentage - The slippage percentage to use
   * @param {Keypair} keypair - The wallet keypair
   * @returns {Promise<Object>} - The swap result
   * @private
   */
  async _executePumpSwapDirectly(tokenAddress, amountInLamports, slippagePercentage, keypair) {
    try {
      logger.info(`Executing PumpSwap direct swap for ${tokenAddress} with ${amountInLamports / 1e9} SOL`);
      
      // Convert slippage percentage to basis points
      const slippageBps = Math.floor(slippagePercentage * 100);
      
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      
      // Execute the swap using the PumpSwap client
      const result = await pumpSwapClient.executeDirectSwap({
        tokenAddress,
        userWallet: keypair,
        solAmount: amountInLamports / 1e9, // Convert lamports to SOL
        slippageBps,
        connection: this.connection
      });
      
      if (!result.success) {
        throw new Error(result.error || 'PumpSwap swap failed');
      }
      
      // Create the result object
      const swapResult = {
        success: true,
        inputAmount: amountInLamports / 1e9, // Convert back to SOL
        outputAmount: result.expectedOutput,
        outputAmountUsd: (amountInLamports / 1e9) * 10, // Simplified USD calculation
        txHash: result.transaction?.signature || result.signature,
        timestamp: Date.now(),
        provider: 'pumpswap-direct'
      };
      
      // Log the trade in database
      await this.logTrade(tokenAddress, swapResult);
      
      logger.info(`PumpSwap swap executed successfully: ${swapResult.txHash}`);
      return swapResult;
    } catch (error) {
      logger.error(`Error executing PumpSwap swap: ${error.message}`);
      
      // If we encounter an RPC-related error, try rotating the endpoint and retry once
      if (error.message.includes('429') || 
          error.message.includes('timeout') || 
          error.message.includes('connection') ||
          error.message.includes('network')) {
        logger.info('Detected RPC issue, rotating endpoint and retrying...');
        this.connection = this.rpcManager.rotateEndpoint();
        logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
        
        // Retry with new connection
        try {
          logger.info(`Retrying PumpSwap swap with new RPC endpoint...`);
          
          // Execute the swap using the PumpSwap client with new connection
          const result = await pumpSwapClient.executeDirectSwap({
            tokenAddress,
            userWallet: keypair,
            solAmount: amountInLamports / 1e9, // Convert lamports to SOL
            slippageBps: Math.floor(slippagePercentage * 100),
            connection: this.connection
          });
          
          if (!result.success) {
            throw new Error(result.error || 'PumpSwap swap failed on retry');
          }
          
          // Create the result object
          const swapResult = {
            success: true,
            inputAmount: amountInLamports / 1e9, // Convert back to SOL
            outputAmount: result.expectedOutput,
            outputAmountUsd: (amountInLamports / 1e9) * 10, // Simplified USD calculation
            txHash: result.transaction?.signature || result.signature,
            timestamp: Date.now(),
            provider: 'pumpswap-direct-retry'
          };
          
          // Log the trade in database
          await this.logTrade(tokenAddress, swapResult);
          
          logger.info(`PumpSwap swap executed successfully on retry: ${swapResult.txHash}`);
          return swapResult;
        } catch (retryError) {
          logger.error(`PumpSwap swap retry failed: ${retryError.message}`);
          throw new Error(`PumpSwap swap failed after retry: ${retryError.message}`);
        }
      }
      
      throw error; // Propagate the error to be handled by the caller
    }
  }
  


  async getTokenBalance(tokenAddress) {
    try {
      const publicKey = wallet.getKeypair().publicKey;
      const tokenPublicKey = new PublicKey(tokenAddress);
      
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      
      // Get all token accounts owned by this wallet
      const tokenAccounts = await this.rpcManager.getParsedTokenAccountsByOwner(
        publicKey,
        { mint: tokenPublicKey }
      );
      
      // If no accounts found, balance is 0
      if (!tokenAccounts.value || tokenAccounts.value.length === 0) {
        return 0;
      }
      
      // Sum up balances from all accounts with this token
      let totalBalance = 0;
      for (const account of tokenAccounts.value) {
        const parsedInfo = account.account.data.parsed.info;
        if (parsedInfo.tokenAmount) {
          totalBalance += Number(parsedInfo.tokenAmount.amount);
        }
      }
      
      return totalBalance;
    } catch (error) {
      logger.error(`Error getting token balance: ${error.message}`);
      return 0;
    }
  }

  async logTrade(tokenAddress, swapResult) {
    try {
      // Get token info from database
      let tokenInfo = await database.getToken(tokenAddress);
      
      // If token info is not in database, try to get it from DexScreener
      if (!tokenInfo) {
        logger.info(`Token ${tokenAddress} not found in database. Trying to get info from DexScreener...`);
        try {
          const dexScreenerInfo = await this.getTokenInfoFromDexScreener(tokenAddress);
          if (dexScreenerInfo) {
            // Create a minimal token info object from DexScreener data
            tokenInfo = {
              name: dexScreenerInfo.name || 'Unknown',
              symbol: dexScreenerInfo.symbol || tokenAddress.substring(0, 6),
              address: tokenAddress
            };
            
            // Try to save this token to the database for future reference
            try {
              await database.saveToken({
                address: tokenAddress,
                name: tokenInfo.name,
                symbol: tokenInfo.symbol,
                decimals: dexScreenerInfo.decimals || 9,
                logoURI: dexScreenerInfo.logoURI || '',
                tags: ['auto-detected']
              });
              logger.info(`Saved token ${tokenInfo.symbol} to database from DexScreener data`);
            } catch (saveError) {
              logger.warn(`Could not save token to database: ${saveError.message}`);
            }
          }
        } catch (dexScreenerError) {
          logger.warn(`Could not get token info from DexScreener: ${dexScreenerError.message}`);
        }
      }
      
      // If still no token info, create a minimal placeholder
      if (!tokenInfo) {
        tokenInfo = {
          name: `Token ${tokenAddress.substring(0, 8)}...`,
          symbol: tokenAddress.substring(0, 6),
          address: tokenAddress
        };
      }
      
      // Save trade to database
      await database.saveTrade({
        tokenAddress: tokenAddress,
        tokenName: tokenInfo.name || 'Unknown',
        tokenSymbol: tokenInfo.symbol || 'UNKNOWN',
        buyPrice: swapResult.outputAmountUsd / swapResult.outputAmount,
        buyAmount: swapResult.outputAmount,
        txHashBuy: swapResult.txHash,
        score: 0, // Will be updated later
        notes: `Auto-buy by trading bot via ${swapResult.provider || 'Jupiter'}`,
        provider: swapResult.provider || 'Jupiter'
      });
      
      logger.info(`Trade logged in database for token ${tokenInfo.symbol} (${tokenAddress}) via ${swapResult.provider || 'Jupiter'}`);
    } catch (error) {
      logger.error(`Error logging trade: ${error.message}`);
    }
  }

  async updateTradeOnSell(tokenAddress, sellResult) {
    try {
      // Get active trades for this token
      const activeTrades = await database.getActiveTrades();
      const trade = activeTrades.find(t => t.token_address === tokenAddress);
      
      if (!trade) {
        logger.warn(`No active trade found for token ${tokenAddress}`);
        return;
      }
      
      // Calculate profit/loss
      const buyValueUsd = trade.buy_price * trade.buy_amount;
      const sellValueUsd = sellResult.outputAmountUsd;
      const profitLoss = sellValueUsd - buyValueUsd;
      const profitLossPercentage = (profitLoss / buyValueUsd) * 100;
      
      // Update trade in database
      await database.updateTradeOnSell(trade.id, {
        sellPrice: sellResult.outputAmountUsd / sellResult.inputAmount,
        sellAmount: sellResult.inputAmount,
        profitLoss: profitLoss,
        profitLossPercentage: profitLossPercentage,
        txHashSell: sellResult.txHash,
        sellProvider: sellResult.provider || 'Jupiter'
      });
      
      logger.info(`Trade updated on sell: ${tokenAddress}, P/L: ${profitLossPercentage.toFixed(2)}%, via ${sellResult.provider || 'Jupiter'}`);
    } catch (error) {
      logger.error(`Error updating trade on sell: ${error.message}`);
    }
  }

  async getOptimalSlippage(tokenAddress) {
    try {
      // Check DexScreener first if enabled
      if (this.useDexScreener && this.currentTokenDexInfo) {
        try {
          // If we have DEX info from a previous check, use it to determine slippage
          const dexInfo = this.currentTokenDexInfo;
          
          // If the token is only on non-Jupiter DEXes, use higher slippage
          if (dexInfo.dexes.length > 0 && dexInfo.jupiterCompatibleDexes.length === 0) {
            logger.info(`Token ${tokenAddress} is only on non-Jupiter DEXes. Using higher slippage.`);
            return 10.0; // 10% slippage for non-Jupiter DEXes
          }
          
          // If the token is on PumpSwap or other high-slippage DEXes, use higher slippage
          const highSlippageDexes = ['pumpswap', 'dooar', 'raydium'];
          const isOnHighSlippageDex = dexInfo.dexes.some(dex => 
            highSlippageDexes.includes(dex.toLowerCase())
          );
          
          // Special case for LOL token
          const tokenInfo = await dexScreenerClient.getTokenInfo(tokenAddress);
          const isLolToken = tokenInfo && 
                            (tokenInfo.name?.toUpperCase().includes('LOL') || 
                             tokenInfo.symbol?.toUpperCase().includes('LOL'));
          
          if (isOnHighSlippageDex || isLolToken) {
            logger.info(`Token ${tokenAddress} is on a high-slippage DEX or is a special case token. Using higher slippage.`);
            return 5.0; // 5% slippage for high-slippage DEXes
          }
        } catch (dexScreenerError) {
          logger.warn(`Error using DexScreener info for slippage calculation: ${dexScreenerError.message}`);
          // Continue to Jupiter calculation
        }
      }
      
      try {
        // Always get the latest connection from the RPC manager
        this.connection = this.rpcManager.getCurrentConnection();
        
        // Initialize Jupiter API client
        const jupiterApi = require('@jup-ag/api');
        const jupiterQuoteApi = jupiterApi.createJupiterApiClient({
          connection: this.connection,
          cluster: 'mainnet-beta',
        });
        
        // Define input and output tokens
        const inputMint = 'So11111111111111111111111111111111111111112'; // SOL
        const outputMint = tokenAddress; // Target token
        
        // Use a small amount for the quote to check liquidity
        const amountInLamports = 0.01 * 1e9; // 0.01 SOL in lamports
        
        // Get quote with rate limiting
        const quoteResponse = await this.jupiterRateLimiter.execute(async () => {
          return await jupiterQuoteApi.quoteGet({
            inputMint,
            outputMint,
            amount: amountInLamports.toString(),
            slippageBps: 100, // 1% for the quote
            onlyDirectRoutes: false,
          });
        }, true); // This is a Price API call
        
        if (!quoteResponse || !quoteResponse.data) {
          logger.error(`No routes found for the input and output mints. Using default.`);
          
          // For new tokens or tokens with limited liquidity, use a higher slippage
          // Check if we have DexScreener info to make a better decision
          if (this.currentTokenDexInfo && this.currentTokenDexInfo.dexes.length > 0) {
            // We have DEX info but no Jupiter routes - likely a new token or on a DEX not supported by Jupiter
            logger.info(`Token has DEX info but no Jupiter routes. Using higher slippage.`);
            return 25.0; // Use a very high slippage (25%) for new tokens with limited Jupiter support
          }
          
          // No DEX info and no routes - use default but higher than normal
          return Math.max(this.defaultSlippage * 2, 5.0); // At least 5% slippage
        }
        
        // Get the quote data
        const quote = quoteResponse.data;
        
        // Calculate price impact
        const priceImpact = quote.priceImpactPct || 0;
        
        // Adjust slippage based on price impact
        // Higher price impact = higher slippage needed
        let optimalSlippage;
        
        if (priceImpact < 0.5) {
          // Low price impact, can use lower slippage
          optimalSlippage = 1.0;
        } else if (priceImpact < 1.0) {
          // Medium price impact
          optimalSlippage = 1.5;
        } else if (priceImpact < 3.0) {
          // Higher price impact
          optimalSlippage = 2.5;
        } else if (priceImpact < 5.0) {
          // Very high price impact
          optimalSlippage = 5.0;
        } else {
          // Extreme price impact
          optimalSlippage = 10.0;
        }
        
        logger.info(`Calculated optimal slippage for ${tokenAddress}: ${optimalSlippage}% (price impact: ${priceImpact}%)`);
        return optimalSlippage;
      } catch (jupiterError) {
        // If Jupiter fails, log the error and use default slippage
        logger.error(`Jupiter failed to calculate optimal slippage: ${jupiterError.message}. Using default.`);
        
        // Check if this is an account info missing error
        if (jupiterError.message.includes('Account info') && jupiterError.message.includes('missing')) {
          // Try rotating the RPC endpoint immediately for this specific error
          const oldEndpoint = this.rpcManager.getCurrentEndpoint();
          this.connection = this.rpcManager.rotateEndpoint();
          logger.info(`Rotated from ${oldEndpoint} to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
          
          // Trigger a health check on all endpoints
          setTimeout(() => {
            this.rpcManager.checkAllEndpointsHealth()
              .then(results => logger.info(`RPC health check results: ${results.healthy}/${results.total} endpoints healthy`))
              .catch(err => logger.error(`Error checking endpoints health: ${err.message}`));
          }, 1000);
          
          // For account info missing errors, use a higher slippage as a precaution
          return Math.max(this.defaultSlippage * 1.5, 2.5); // At least 2.5% slippage
        }
        
        // Check if this is a rate limit error
        if (jupiterError.message.includes('429') || jupiterError.message.includes('Too Many Requests')) {
          logger.warn('Rate limit detected, cooling down Jupiter API requests');
          // Force a cooldown period
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else if (jupiterError.message.includes('fetch failed') || 
                  jupiterError.message.includes('ECONNREFUSED') || 
                  jupiterError.message.includes('ECONNRESET') || 
                  jupiterError.message.includes('socket hang up') ||
                  jupiterError.message.includes('timeout') ||
                  jupiterError.message.includes('timed out')) {
          logger.warn(`Network error detected: ${jupiterError.message}. Rotating RPC endpoint...`);
        } else if (jupiterError.message.includes('403') || 
                  jupiterError.message.includes('Forbidden') || 
                  jupiterError.message.includes('Unauthorized') || 
                  jupiterError.message.includes('API key')) {
          logger.warn(`Authentication error detected: ${jupiterError.message}. Rotating RPC endpoint...`);
        }
        
        // Try rotating the RPC endpoint for any Jupiter error
        const oldEndpoint = this.rpcManager.getCurrentEndpoint();
        this.connection = this.rpcManager.rotateEndpoint();
        logger.info(`Rotated from ${oldEndpoint} to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
        
        // Trigger a health check on all endpoints
        setTimeout(() => {
          this.rpcManager.checkAllEndpointsHealth()
            .catch(err => logger.error(`Error checking endpoints health: ${err.message}`));
        }, 1000);
        
        // If we have DexScreener info, use a higher default slippage
        if (this.currentTokenDexInfo && this.currentTokenDexInfo.dexes.length > 0) {
          return 5.0; // Higher default for tokens with known DEXes
        }
        
        return this.defaultSlippage;
      }
    } catch (error) {
      logger.error(`Error calculating optimal slippage: ${error.message}`);
      return this.defaultSlippage;
    }
  }

  async estimateGasFee() {
    try {
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      
      // Get recent blockhash for fee calculation
      const { lastValidBlockHeight, blockhash } = await this.connection.getLatestBlockhash();
      
      // Get the fee for a simple transaction
      const feeCalculator = await this.connection.getFeeForMessage(
        new Transaction().add({
          keys: [],
          programId: new PublicKey('11111111111111111111111111111111')
        }).compileMessage(),
        'confirmed'
      );
      
      // Convert to SOL
      return (feeCalculator.value || 5000) / 1e9; // Default to 5000 lamports if value is null
    } catch (error) {
      logger.error(`Error estimating gas fee: ${error.message}`);
      return 0.000005; // Default estimate
    }
  }
  
  /**
   * Get token information from DexScreener
   * @param {string} tokenAddress - The token address to get information for
   * @returns {Promise<Object|null>} - Token information or null if not found
   */
  async getTokenInfoFromDexScreener(tokenAddress) {
    try {
      if (!this.useDexScreener) {
        logger.info(`DexScreener integration is disabled. Skipping token info lookup.`);
        return null;
      }
      
      logger.info(`Getting token info from DexScreener for: ${tokenAddress}`);
      const tokenInfo = await dexScreenerClient.getTokenInfo(tokenAddress);
      
      if (!tokenInfo) {
        logger.warn(`No token info found on DexScreener for: ${tokenAddress}`);
        return null;
      }
      
      logger.info(`Found token info on DexScreener: ${tokenInfo.name} (${tokenInfo.symbol})`);
      logger.info(`Price: ${tokenInfo.priceUsd}, 24h change: ${tokenInfo.priceChange24h}%`);
      logger.info(`Total liquidity: ${tokenInfo.totalLiquidityUsd}, 24h volume: ${tokenInfo.totalVolume24h}`);
      
      return tokenInfo;
    } catch (error) {
      logger.error(`Error getting token info from DexScreener: ${error.message}`);
      return null;
    }
  }
  
  /**
   * Execute a swap using Jupiter API directly instead of the SDK
   * @param {string} tokenAddress - The token address to swap to
   * @param {number} amountInSol - The amount in SOL to swap
   * @param {number} slippage - The slippage percentage to use
   * @returns {Promise<Object>} - The swap result
   */
  async executeJupiterApiSwap(tokenAddress, amountInSol, slippage = null) {
    try {
      const slippageBps = Math.floor((slippage || this.defaultSlippage) * 100);
      const amountInLamports = Math.floor(amountInSol * 1e9);
      const keypair = wallet.getKeypair();
      
      logger.info(`Executing Jupiter API swap for ${tokenAddress} with ${amountInSol} SOL (slippage: ${slippageBps} bps)`);
      
      // Define input and output tokens
      const inputMint = 'So11111111111111111111111111111111111111112'; // SOL
      const outputMint = tokenAddress;
      
      // Step 1: Get quote from Jupiter API
      logger.info(`Getting Jupiter API quote for ${inputMint} -> ${outputMint}`);
      
      // Determine API base URL based on tier
      const apiBaseUrl = this.jupiterRateLimiter.config.apiKey ? 
        'https://lite-api.jup.ag' : 'https://lite-api.jup.ag'; // Use lite-api.jup.ag for free tier, api.jup.ag for paid tiers
      
      // Build query parameters
      const quoteParams = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amountInLamports.toString(),
        slippageBps: slippageBps.toString(),
        onlyDirectRoutes: 'false',
        asLegacyTransaction: 'false',
        // Optional parameters
        platformFeeBps: this.jupiterRateLimiter.config.platformFeeBps || '0',
      });
      
      // If API key is available, add it to headers
      const headers = {
        'Content-Type': 'application/json',
      };
      
      if (this.jupiterRateLimiter.config.apiKey) {
        headers['Jupiter-API-Key'] = this.jupiterRateLimiter.config.apiKey;
      }
      
      // Get quote with rate limiting
      const quoteResponse = await this.jupiterRateLimiter.execute(async () => {
        const response = await fetch(`${apiBaseUrl}/swap/v1/quote?${quoteParams.toString()}`, {
          method: 'GET',
          headers,
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Jupiter API quote failed with status ${response.status}: ${errorText}`);
        }
        
        return await response.json();
      }, true); // This is a price API call
      
      if (!quoteResponse || !quoteResponse.outAmount) {
        throw new Error('Invalid quote response from Jupiter API');
      }
      
      logger.info(`Got quote with output amount: ${quoteResponse.outAmount} (${quoteResponse.outAmountWithSlippage} with slippage)`);
      
      // Step 2: Get swap transaction
      const swapParams = {
        quoteResponse,
        userPublicKey: keypair.publicKey.toString(),
        wrapUnwrapSOL: true,
        dynamicComputeUnitLimit: true, // Automatically calculate CU limit
      };
      
      // If platform fee is configured, add it
      if (this.jupiterRateLimiter.config.platformFeeBps && 
          this.jupiterRateLimiter.config.platformFeeBps > 0 &&
          this.jupiterRateLimiter.config.feeAccount) {
        swapParams.platformFeeBps = this.jupiterRateLimiter.config.platformFeeBps;
        swapParams.feeAccount = this.jupiterRateLimiter.config.feeAccount;
      }
      
      // Get swap transaction with rate limiting
      const swapResponse = await this.jupiterRateLimiter.execute(async () => {
        const response = await fetch(`${apiBaseUrl}/v6/swap`, {
          method: 'POST',
          headers,
          body: JSON.stringify(swapParams),
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Jupiter API swap transaction failed with status ${response.status}: ${errorText}`);
        }
        
        return await response.json();
      }, false); // Not a price API call
      
      if (!swapResponse || !swapResponse.swapTransaction) {
        throw new Error('Invalid swap transaction response from Jupiter API');
      }
      
      logger.info(`Got swap transaction from Jupiter API`);
      
      // Step 3: Deserialize and sign the transaction
      const transactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
      const transaction = Transaction.from(transactionBuf);
      
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      
      // Sign and send the transaction
      logger.info(`Sending Jupiter API swap transaction...`);
      const txid = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [keypair],
        { skipPreflight: false, maxRetries: 2 }
      );
      
      logger.info(`Jupiter API swap transaction confirmed: ${txid}`);
      
      // Extract output amount from quote
      const outputAmount = Number(quoteResponse.outAmount);
      
      // Get approximate USD value (this is simplified)
      const outputAmountUsd = amountInSol * 10; // Placeholder, replace with actual price data
      
      const swapResult = {
        success: true,
        inputAmount: amountInSol,
        outputAmount: outputAmount,
        outputAmountUsd: outputAmountUsd,
        txHash: txid,
        timestamp: Date.now(),
        provider: 'jupiterApi'
      };
      
      // Log the trade in database
      await this.logTrade(tokenAddress, swapResult);
      
      logger.info(`Jupiter API swap executed successfully: ${swapResult.txHash}`);
      return swapResult;
    } catch (error) {
      logger.error(`Error executing Jupiter API swap: ${error.message}`);
      
      // If we encounter an RPC-related error, try rotating the endpoint
      if (error.message.includes('429') || 
          error.message.includes('timeout') || 
          error.message.includes('connection') ||
          error.message.includes('network')) {
        logger.info('Detected RPC issue, rotating endpoint...');
        this.connection = this.rpcManager.rotateEndpoint();
        logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
      }
      
      throw error; // Propagate the error to be handled by the caller
    }
  }

  /**
   * Execute a sell using Jupiter API directly
   * @param {string} tokenAddress - The token address to sell
   * @param {number} amountIn - The amount of tokens to sell
   * @param {number} slippage - The slippage percentage to use
   * @returns {Promise<Object>} - The sell result
   */
  async executeJupiterApiSell(tokenAddress, amountIn, slippage = null) {
    try {
      // Import Jupiter API SDK
      const jupiterApi = require('@jup-ag/api');
      
      const slippageBps = Math.floor((slippage || this.defaultSlippage) * 100);
      const keypair = wallet.getKeypair();
      
      logger.info(`Executing Jupiter API sell for ${tokenAddress} with amount ${amountIn} (slippage: ${slippageBps} bps)`);
      
      // Define input and output tokens
      const inputMint = tokenAddress; // Token to sell
      const outputMint = 'So11111111111111111111111111111111111111112'; // SOL
      
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      
      // Initialize Jupiter API client
      const jupiterQuoteApi = jupiterApi.createJupiterApiClient({
        connection: this.connection,
        cluster: 'mainnet-beta',
      });
      
      logger.info(`Jupiter API SDK initialized successfully for sell`);
      
      // Step 1: Get quote
      logger.info(`Getting Jupiter API quote for ${inputMint} -> ${outputMint}`);
      
      const quoteResponse = await jupiterQuoteApi.quoteGet({
        inputMint,
        outputMint,
        amount: amountIn.toString(),
        slippageBps,
        onlyDirectRoutes: false,
      });
      
      if (!quoteResponse || !quoteResponse.data) {
        throw new Error('Failed to get quote from Jupiter API');
      }
      
      const quote = quoteResponse.data;
      logger.info(`Received quote with output amount: ${quote.outAmount}`);
      
      // Step 2: Create a swap transaction using the quote
      logger.info(`Creating swap transaction using quote...`);
      
      // Add priority fee to improve chances of inclusion
      const priorityFee = 10000; // 0.00001 SOL fee
      
      // Create the swap transaction
      const swapResponse = await jupiterQuoteApi.swapPost({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toString(),
        wrapUnwrapSOL: true,
        priorityFee: {
          priorityLevel: 'HIGH',
          useSmartFee: true,
        },
        computeUnitPriceMicroLamports: priorityFee,
        dynamicComputeUnitLimit: true, // Automatically calculate CU limit
      });
      
      if (!swapResponse || !swapResponse.data || !swapResponse.data.swapTransaction) {
        throw new Error('Failed to create swap transaction');
      }
      
      // Step 3: Sign and send the transaction
      logger.info(`Signing and sending swap transaction...`);
      
      // Deserialize the transaction
      const serializedTransaction = swapResponse.data.swapTransaction;
      const transactionBuffer = Buffer.from(serializedTransaction, 'base64');
      
      // Determine if it's a versioned or legacy transaction
      let transaction;
      if (transactionBuffer[0] === 0x80) {
        // Versioned transaction
        const { VersionedTransaction } = require('@solana/web3.js');
        transaction = VersionedTransaction.deserialize(transactionBuffer);
        // Sign the transaction
        transaction.sign([keypair]);
      } else {
        // Legacy transaction
        const { Transaction } = require('@solana/web3.js');
        transaction = Transaction.from(transactionBuffer);
        // Sign the transaction
        transaction.partialSign(keypair);
      }
      
      // Send the transaction
      const txid = await this.connection.sendRawTransaction(
        transaction.serialize(),
        { skipPreflight: false, maxRetries: 3 }
      );
      
      // Wait for confirmation
      const confirmation = await this.connection.confirmTransaction(txid, 'confirmed');
      
      if (confirmation.value.err) {
        throw new Error(`Transaction confirmed but has errors: ${JSON.stringify(confirmation.value.err)}`);
      }
      
      logger.info(`Jupiter API sell transaction confirmed: ${txid}`);
      
      // Extract output amount from the quote
      const outputAmount = Number(quote.outAmount) / Math.pow(10, quote.outputDecimals || 9);
      
      // Get approximate USD value (this is simplified)
      const outputAmountUsd = outputAmount * 100; // Placeholder, replace with actual price data
      
      const sellResult = {
        success: true,
        inputAmount: amountIn,
        outputAmountSol: outputAmount,
        outputAmountUsd: outputAmountUsd,
        txHash: txid,
        timestamp: Date.now(),
        provider: 'jupiterApi'
      };
      
      // Update the trade in database
      await this.updateTradeOnSell(tokenAddress, sellResult);
      
      logger.info(`Jupiter API sell executed successfully: ${sellResult.txHash}`);
      return sellResult;
    } catch (error) {
      logger.error(`Error executing Jupiter API sell: ${error.message}`);
      
      // If we encounter an RPC-related error, try rotating the endpoint
      if (error.message.includes('429') || 
          error.message.includes('timeout') || 
          error.message.includes('connection') ||
          error.message.includes('network')) {
        logger.info('Detected RPC issue, rotating endpoint...');
        this.connection = this.rpcManager.rotateEndpoint();
        logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
      }
      
      throw error; // Propagate the error to be handled by the caller
    }
  }

  async testTrade(tokenAddress, amountInSol = 0.01) {
    try {
      logger.info(`Executing test trade for ${tokenAddress} with ${amountInSol} SOL`);
      
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      
      // Get wallet balance
      const walletBalance = await this.getWalletBalance();
      if (walletBalance < amountInSol) {
        logger.error(`Insufficient balance: ${walletBalance} SOL, needed ${amountInSol} SOL`);
        return {
          success: false,
          error: 'Insufficient balance',
        };
      }
      
      // Check for active trading pairs using DexScreener if enabled
      if (this.useDexScreener) {
        try {
          logger.info(`Checking DexScreener for active pairs for token: ${tokenAddress}`);
          const dexScreenerResult = await dexScreenerClient.checkActivePairs(tokenAddress, {
            requireVerifiedPair: this.requireVerifiedPair,
            minLiquidityUsd: this.dexScreenerMinLiquidity / 2, // Lower threshold for test trades
            minVolumeUsd: this.dexScreenerMinVolume / 2, // Lower threshold for test trades
            preferredDexes: this.preferredDexes
          });
          
          if (!dexScreenerResult.hasActivePairs) {
            logger.error(`No active trading pairs found for token ${tokenAddress} on DexScreener. Aborting test trade.`);
            return {
              success: false,
              error: 'No active trading pairs found on DexScreener',
              dexScreenerResult
            };
          }
          
          // Check if we require Jupiter-compatible pairs
          if (this.requireJupiterCompatiblePair && !dexScreenerResult.hasJupiterCompatiblePairs) {
            logger.error(`No Jupiter-compatible trading pairs found for token ${tokenAddress}. Aborting test trade.`);
            return {
              success: false,
              error: 'No Jupiter-compatible trading pairs found',
              dexScreenerResult
            };
          }
          
          // Get detailed DEX information to help with routing
          const dexInfo = await dexScreenerClient.getTokenDexInfo(tokenAddress);
          
          // Log the best pair information
          if (dexScreenerResult.bestPair) {
            const bestPair = dexScreenerResult.bestPair;
            logger.info(`Found active trading pair on ${bestPair.dexId} with ${bestPair.liquidity?.usd} liquidity and ${bestPair.volume?.h24} 24h volume`);
          }
          
          // Store DEX info for use during swap execution
          this.currentTokenDexInfo = dexInfo;
          
          if (dexInfo.jupiterCompatibleDexes.length > 0) {
            logger.info(`Jupiter-compatible DEXes for ${tokenAddress}: ${dexInfo.jupiterCompatibleDexes.join(', ')}`);
          }
        } catch (dexScreenerError) {
          // Log the error but continue with the test trade
          logger.warn(`Error checking DexScreener: ${dexScreenerError.message}. Continuing with test trade anyway.`);
          this.currentTokenDexInfo = null;
        }
      } else {
        this.currentTokenDexInfo = null;
      }
      
      // Check if we should use Jupiter API directly for test trades
      if (this.useJupiterApi && this.preferJupiterApi) {
        try {
          logger.info(`Using Jupiter API directly for test trade: ${tokenAddress}`);
          return await this.executeJupiterApiSwap(tokenAddress, amountInSol);
        } catch (jupiterApiError) {
          logger.error(`Jupiter API direct test trade failed: ${jupiterApiError.message}. Falling back to standard swap.`);
          // Continue to standard swap execution
        }
      }
      
      // Check if we should use Raydium directly for test trades
      if (this.hasRaydiumFallback) {
        try {
          logger.info(`Using Raydium directly for test trade: ${tokenAddress}`);
          return await this.executeRaydiumDirectly(tokenAddress, amountInSol);
        } catch (raydiumError) {
          logger.error(`Raydium direct test trade failed: ${raydiumError.message}. Falling back to standard swap.`);
          // Continue to standard swap execution
        }
      }
      
      // Execute the swap
      return await this.executeSwap(tokenAddress, amountInSol);
    } catch (error) {
      logger.error(`Error executing test trade: ${error.message}`);
      
      // If we encounter an RPC-related error, try rotating the endpoint
      if (error.message.includes('429') || 
          error.message.includes('timeout') || 
          error.message.includes('connection') ||
          error.message.includes('network')) {
        logger.info('Detected RPC issue, rotating endpoint...');
        this.connection = this.rpcManager.rotateEndpoint();
        logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
      }
      
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check if a token is tradable on Jupiter
   * @param {string} tokenAddress - The token address to check
   * @returns {Promise<Object>} - The check result
   */
  async checkJupiterTradability(tokenAddress) {
    try {
      logger.info(`Checking Jupiter tradability for ${tokenAddress}`);
      
      // Validate input parameters
      if (!tokenAddress) {
        throw new Error('Token address is required');
      }
      
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      
      // Initialize Jupiter with rate limiting
      const jupiterInstance = await this.jupiterRateLimiter.execute(async () => {
        return await Jupiter.load({
          connection: this.connection,
          cluster: 'mainnet-beta',
          user: wallet.getKeypair(),
          apiKey: this.jupiterRateLimiter.config.apiKey,
        });
      }, false); // Not a Price API call
      
      // Define input and output tokens
      const inputMint = new PublicKey('So11111111111111111111111111111111111111112'); // SOL
      const outputMint = new PublicKey(tokenAddress); // Target token
      
      // Use a small amount for the check
      const amountInLamports = 0.01 * 1e9; // 0.01 SOL in lamports
      
      // Get routes with rate limiting
      logger.info(`Getting routes for tradability check with ${amountInLamports} lamports`);
      const routes = await this.jupiterRateLimiter.execute(async () => {
        return await jupiterInstance.computeRoutes({
          inputMint,
          outputMint,
          amount: amountInLamports,
          slippageBps: 100, // 1% for the check
          forceFetch: true,
        });
      }, true); // This is a Price API call
      
      const hasTradingRoutes = routes.routesInfos && routes.routesInfos.length > 0;
      
      if (hasTradingRoutes) {
        // Get the best route details
        const bestRoute = routes.routesInfos[0];
        const priceImpact = bestRoute.priceImpactPct || 0;
        const expectedOutputAmount = Number(bestRoute.outAmount);
        
        logger.info(`Token ${tokenAddress} is tradable on Jupiter with ${routes.routesInfos.length} routes`);
        logger.info(`Best route price impact: ${priceImpact}%, expected output: ${expectedOutputAmount}`);
        
        return {
          tradable: true,
          routesCount: routes.routesInfos.length,
          priceImpact,
          expectedOutputAmount,
          bestMarket: bestRoute.marketInfos?.[0]?.label || 'Unknown'
        };
      } else {
        logger.info(`Token ${tokenAddress} is not tradable on Jupiter (no routes found)`);
        return {
          tradable: false,
          routesCount: 0
        };
      }
    } catch (error) {
      logger.error(`Error checking Jupiter tradability: ${error.message}`);
      
      // If we encounter an RPC-related error, try rotating the endpoint
      if (error.message.includes('429') || 
          error.message.includes('timeout') || 
          error.message.includes('connection') ||
          error.message.includes('network')) {
        logger.info('Detected RPC issue, rotating endpoint...');
        this.connection = this.rpcManager.rotateEndpoint();
        logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
      }
      
      return {
        tradable: false,
        error: error.message
      };
    }
  }

  /**
   * Execute a sell operation using Jupiter SDK
   * @param {string} tokenAddress - The token address to sell
   * @param {number} tokenAmount - The amount of tokens to sell
   * @param {number} slippage - The slippage percentage to use
   * @returns {Promise<Object>} - The sell result
   */
  async executeJupiterSell(tokenAddress, tokenAmount, slippage = null) {
    try {
      logger.info(`Executing Jupiter SDK sell for ${tokenAddress} with ${tokenAmount} tokens`);
      
      // Validate input parameters
      if (!tokenAddress) {
        throw new Error('Token address is required');
      }
      
      if (!tokenAmount || tokenAmount <= 0) {
        throw new Error('Amount must be greater than 0');
      }
      
      // Use provided slippage or default
      const slippageToUse = slippage !== null ? slippage : this.defaultSlippage;
      const slippageBps = Math.floor(slippageToUse * 100); // Convert to basis points
      
      // Get the keypair
      const keypair = wallet.getKeypair();
      
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      
      // Initialize Jupiter with rate limiting
      const jupiterInstance = await this.jupiterRateLimiter.execute(async () => {
        return await Jupiter.load({
          connection: this.connection,
          cluster: 'mainnet-beta',
          user: keypair,
          apiKey: this.jupiterRateLimiter.config.apiKey,
        });
      }, false); // Not a Price API call
      
      // Define input and output tokens
      const inputMint = new PublicKey(tokenAddress); // Token to sell
      const outputMint = new PublicKey('So11111111111111111111111111111111111111112'); // SOL
      
      // Get routes with rate limiting
      logger.info(`Getting routes for ${tokenAmount} tokens with ${slippageBps} bps slippage`);
      const routes = await this.jupiterRateLimiter.execute(async () => {
        return await jupiterInstance.computeRoutes({
          inputMint,
          outputMint,
          amount: tokenAmount,
          slippageBps,
          forceFetch: true,
        });
      }, true); // This is a Price API call
      
      if (!routes.routesInfos || routes.routesInfos.length === 0) {
        logger.error(`No routes found for selling the token`);
        return {
          success: false,
          error: 'No routes found',
        };
      }
      
      // Select the best route
      const bestRoute = routes.routesInfos[0];
      logger.info(`Selected route with output: ${bestRoute.outAmount} lamports`);
      
      // Execute the swap with rate limiting
      const { execute } = await this.jupiterRateLimiter.execute(async () => {
        return await jupiterInstance.exchange({
          routeInfo: bestRoute,
        });
      }, false); // Not a Price API call
      
      const result = await this.jupiterRateLimiter.execute(async () => {
        return await execute();
      }, false); // Not a Price API call
      
      if (result.error) {
        logger.error(`Sell execution failed: ${result.error}`);
        return {
          success: false,
          error: result.error,
        };
      }
      
      // Extract transaction details
      const txHash = result.txid;
      const outputAmountLamports = Number(bestRoute.outAmount);
      const outputAmountSol = outputAmountLamports / 1e9; // Convert lamports to SOL
      
      // Get approximate USD value (this is simplified)
      const outputAmountUsd = outputAmountSol * 100; // Placeholder, replace with actual price data
      
      const sellResult = {
        success: true,
        inputAmount: tokenAmount,
        outputAmountSol: outputAmountSol,
        outputAmountUsd: outputAmountUsd,
        txHash: txHash,
        timestamp: Date.now(),
        provider: 'jupiter-sdk'
      };
      
      // Update the trade in database
      await this.updateTradeOnSell(tokenAddress, sellResult);
      
      logger.info(`Jupiter SDK sell executed successfully: ${sellResult.txHash}`);
      return sellResult;
    } catch (error) {
      logger.error(`Error executing Jupiter SDK sell: ${error.message}`);
      
      // If we encounter an RPC-related error, try rotating the endpoint
      if (error.message.includes('429') || 
          error.message.includes('timeout') || 
          error.message.includes('connection') ||
          error.message.includes('network')) {
        logger.info('Detected RPC issue, rotating endpoint...');
        this.connection = this.rpcManager.rotateEndpoint();
        logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
      }
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute a swap using Jupiter SDK
   * @param {string} tokenAddress - The token address to swap to
   * @param {number} amountInSol - The amount in SOL to swap
   * @param {number} slippage - The slippage percentage to use
   * @returns {Promise<Object>} - The swap result
   */
  async executeJupiterSwap(tokenAddress, amountInSol, slippage = null) {
    try {
      logger.info(`Executing Jupiter SDK swap for ${tokenAddress} with ${amountInSol} SOL`);
      
      // Validate input parameters
      if (!tokenAddress) {
        throw new Error('Token address is required');
      }
      
      if (!amountInSol || amountInSol <= 0) {
        throw new Error('Amount must be greater than 0');
      }
      
      if (amountInSol > this.maxTradeSizeSol) {
        throw new Error(`Amount exceeds maximum trade size of ${this.maxTradeSizeSol} SOL`);
      }
      
      // Convert SOL to lamports
      const amountInLamports = Math.floor(amountInSol * 1e9);
      
      // Use provided slippage or default
      const slippageToUse = slippage !== null ? slippage : this.defaultSlippage;
      const slippageBps = Math.floor(slippageToUse * 100); // Convert to basis points
      
      // Get the keypair
      const keypair = wallet.getKeypair();
      
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      
      // Initialize Jupiter with rate limiting
      const jupiterInstance = await this.jupiterRateLimiter.execute(async () => {
        return await Jupiter.load({
          connection: this.connection,
          cluster: 'mainnet-beta',
          user: keypair,
          apiKey: this.jupiterRateLimiter.config.apiKey,
        });
      }, false); // Not a Price API call
      
      // Define input and output tokens
      const inputMint = new PublicKey('So11111111111111111111111111111111111111112'); // SOL
      const outputMint = new PublicKey(tokenAddress); // Target token
      
      // Get routes with rate limiting
      logger.info(`Getting routes for ${amountInLamports} lamports with ${slippageBps} bps slippage`);
      const routes = await this.jupiterRateLimiter.execute(async () => {
        return await jupiterInstance.computeRoutes({
          inputMint,
          outputMint,
          amount: amountInLamports,
          slippageBps,
          forceFetch: true,
        });
      }, true); // This is a Price API call
      
      if (!routes.routesInfos || routes.routesInfos.length === 0) {
        logger.error(`No routes found for the input and output mints`);
        return {
          success: false,
          error: 'No routes found',
        };
      }
      
      // Select the best route
      const bestRoute = routes.routesInfos[0];
      logger.info(`Selected route with output: ${bestRoute.outAmount} tokens`);
      
      // Execute the swap with rate limiting
      const { execute } = await this.jupiterRateLimiter.execute(async () => {
        return await jupiterInstance.exchange({
          routeInfo: bestRoute,
        });
      }, false); // Not a Price API call
      
      const result = await this.jupiterRateLimiter.execute(async () => {
        return await execute();
      }, false); // Not a Price API call
      
      if (result.error) {
        logger.error(`Swap execution failed: ${result.error}`);
        return {
          success: false,
          error: result.error,
        };
      }
      
      // Extract transaction details
      const txHash = result.txid;
      const outputAmount = Number(bestRoute.outAmount);
      
      // Get approximate USD value (this is simplified)
      const outputAmountUsd = amountInSol * 10; // Placeholder, replace with actual price data
      
      const swapResult = {
        success: true,
        inputAmount: amountInSol,
        outputAmount: outputAmount,
        outputAmountUsd: outputAmountUsd,
        txHash: txHash,
        timestamp: Date.now(),
        provider: 'jupiter-sdk'
      };
      
      // Log the trade in database
      await this.logTrade(tokenAddress, swapResult);
      
      logger.info(`Jupiter SDK swap executed successfully: ${swapResult.txHash}`);
      return swapResult;
    } catch (error) {
      logger.error(`Error executing Jupiter SDK swap: ${error.message}`);
      
      // If we encounter an RPC-related error, try rotating the endpoint
      if (error.message.includes('429') || 
          error.message.includes('timeout') || 
          error.message.includes('connection') ||
          error.message.includes('network')) {
        logger.info('Detected RPC issue, rotating endpoint...');
        this.connection = this.rpcManager.rotateEndpoint();
        logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
      }
      
      return {
        success: false,
        error: error.message
      };
    }
  }
  /**
   * Execute a swap directly through Raydium
   * @param {string} tokenAddress - Token address
   * @param {number} amountInLamports - Amount in lamports
   * @param {number} slippage - Slippage percentage
   * @param {Object} keypair - Wallet keypair
   * @returns {Promise<Object>} - Swap result
   */
  async _executeRaydiumDirectly(tokenAddress, amountInLamports, slippage, keypair) {
    try {
      logger.info(`Executing Raydium swap directly for ${tokenAddress} with ${amountInLamports/1e9} SOL (${slippage}% slippage)`);
      
      // Always get the latest connection from the RPC manager
      const connection = this.rpcManager.getCurrentConnection();
      
      // Set the connection on the raydiumClient
      raydiumClient.setConnection(connection);
      
      // Use the raydiumClient to execute the swap
      const result = await raydiumClient.executeSwap(tokenAddress, amountInLamports, slippage, keypair);
      
      // Extract transaction details
      const txHash = result.txHash;
      const outputAmount = result.outputAmount;
      
      // Get approximate USD value (this is simplified)
      const outputAmountUsd = (amountInLamports / 1e9) * 100; // Placeholder, replace with actual price data
      
      const swapResult = {
        success: true,
        txHash: txHash,
        inputAmount: amountInLamports / 1e9,
        outputAmount: outputAmount,
        outputAmountUsd: outputAmountUsd,
        timestamp: Date.now(),
        provider: 'Raydium'
      };
      
      // Log the trade in database
      await this.logTrade(tokenAddress, swapResult);
      
      logger.info(`Raydium swap executed successfully: ${swapResult.txHash}`);
      return swapResult;
    } catch (error) {
      logger.error(`Error executing Raydium swap: ${error.message}`);
      
      // If we encounter an RPC-related error, try rotating the endpoint
      if (error.message.includes('429') || 
          error.message.includes('timeout') || 
          error.message.includes('connection') ||
          error.message.includes('network')) {
        logger.info('Detected RPC issue, rotating endpoint...');
        this.connection = this.rpcManager.rotateEndpoint();
        logger.info(`Rotated to new RPC endpoint: ${this.rpcManager.getCurrentEndpoint()}`);
      }
      
      return {
        success: false,
        error: `Raydium swap failed: ${error.message}`
      };
    }
  }

  /**
   * Log a trade to the database
   * @param {string} tokenAddress - The token address
   * @param {Object} swapResult - The swap result
   * @returns {Promise<boolean>} - Whether the logging was successful
   */
  async logTrade(tokenAddress, swapResult) {
    try {
      logger.info(`Logging trade for ${tokenAddress}: ${JSON.stringify(swapResult)}`);
      
      // Here you would implement the actual database logging
      // For example, using a database client to insert the trade record
      
      // For now, we'll just log it and return success
      return true;
    } catch (error) {
      logger.error(`Error logging trade: ${error.message}`);
      return false;
    }
  }
}

module.exports = new SwapExecutor();