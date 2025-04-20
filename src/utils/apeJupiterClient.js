/**
 * ApeJupiter API Client
 * 
 * This module provides a client for interacting with the ApeJupiter API (Ape Pro)
 * for memecoin trading on Solana.
 * 
 * Extended with Raydium and PumpSwap integration for better coverage of DEXes.
 */

const axios = require('axios');
const { PublicKey, Transaction, Connection, VersionedTransaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const config = require('../../config/config');
const logger = require('./logger');
const wallet = require('./wallet');
const rpcManager = require('./rpcManager');

// Import Raydium and PumpSwap clients for direct integration
let raydiumClient;
let pumpSwapClient;

try {
  raydiumClient = require('./raydiumDirectClient');
  // Ensure the client has the required methods
  if (!raydiumClient.getQuote || typeof raydiumClient.getQuote !== 'function') {
    raydiumClient.getQuote = async function(params) {
      logger.info(`Raydium fallback getQuote called with params: ${JSON.stringify(params)}`);
      // Implement a basic quote function
      return {
        success: false,
        message: 'Not implemented'
      };
    };
  }
  logger.info('Raydium client loaded successfully in ApeJupiterClient');
} catch (error) {
  logger.warn(`Failed to load Raydium client in ApeJupiterClient: ${error.message}`);
}

try {
  pumpSwapClient = require('./pumpSwapClient');
  // Ensure the client has the required methods
  if (!pumpSwapClient.getQuote || typeof pumpSwapClient.getQuote !== 'function') {
    pumpSwapClient.getQuote = async function(params) {
      logger.info(`PumpSwap fallback getQuote called with params: ${JSON.stringify(params)}`);
      // Implement a basic quote function
      return {
        success: false,
        message: 'Not implemented'
      };
    };
    logger.warn('Added missing getQuote method to PumpSwap client');
  }
  logger.info('PumpSwap client loaded successfully in ApeJupiterClient');
} catch (error) {
  logger.warn(`Failed to load PumpSwap client in ApeJupiterClient: ${error.message}`);
}

class ApeJupiterClient {
  constructor(options = {}) {
    // Handle case where config might not be fully initialized
    const apeJupiterConfig = config.trading?.apeJupiter || {};
    
    this.apiBaseUrl = options.apiBaseUrl || apeJupiterConfig.apiBaseUrl || 'https://lite-api.jup.ag/swap/v1';
    this.apiKey = options.apiKey || apeJupiterConfig.apiKey;
    this.useMevProtection = options.useMevProtection !== undefined ? options.useMevProtection : (apeJupiterConfig.useMevProtection || true);
    this.feePercentage = options.feePercentage || apeJupiterConfig.feePercentage || 0;
    this.maxPriceImpactPct = options.maxPriceImpactPct || apeJupiterConfig.maxPriceImpactPct || 15;
    this.defaultSlippage = options.defaultSlippage || config.trading?.defaultSlippage || 0.05; // 5% default slippage
    
    // Initialize RPC manager for connection handling
    this.rpcManager = rpcManager;
    this.connection = this.rpcManager.getCurrentConnection();
    
    // Configure axios instance with default headers
    this.api = axios.create({
      baseURL: this.apiBaseUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
      },
      timeout: 30000 // 30 seconds timeout
    });
    
    // Initialize Jupiter rate limiter config if available
    this.jupiterRateLimiter = options.jupiterRateLimiter || config.trading?.jupiter?.rateLimiter || null;
    
    // Initialize Raydium and PumpSwap integration flags
    this.useRaydiumFallback = options.useRaydiumFallback !== undefined ? options.useRaydiumFallback : (config.trading?.raydium?.enabled !== false); // Enabled by default
    this.usePumpSwapFallback = options.usePumpSwapFallback !== undefined ? options.usePumpSwapFallback : (config.trading?.pumpSwap?.enabled !== false); // Enabled by default
    
    logger.info(`ApeJupiter client initialized with API URL: ${this.apiBaseUrl}`);
    logger.info(`MEV protection: ${this.useMevProtection ? 'Enabled' : 'Disabled'}`);
    logger.info(`Raydium fallback: ${this.useRaydiumFallback ? 'Enabled' : 'Disabled'}`);
    logger.info(`PumpSwap fallback: ${this.usePumpSwapFallback ? 'Enabled' : 'Disabled'}`);
  }
  
  /**
   * Execute a swap using the best available method
   * @param {string} tokenAddress - The mint address of the token to buy
   * @param {number} amountInSol - Amount of SOL to spend
   * @param {number} slippage - The slippage tolerance as a decimal (e.g., 0.05 = 5%)
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - The swap result
   */
  async executeSwap(tokenAddress, amountInSol, slippage = null, options = {}) {
    try {
      logger.info(`Executing swap for ${tokenAddress} with ${amountInSol} SOL`);
      
      // Validate inputs
      if (!tokenAddress) {
        throw new Error('Token address is required');
      }
      
      if (!amountInSol || amountInSol <= 0) {
        throw new Error('Amount must be greater than 0');
      }
      
      // Set default slippage if not provided
      const effectiveSlippage = slippage || this.defaultSlippage;
      logger.info(`Using slippage: ${effectiveSlippage * 100}%`);
      
      // Always use Jupiter SDK as the primary method
      try {
        logger.info(`Using Jupiter SDK for swap`);
        return await this.executeJupiterApiSwap(tokenAddress, amountInSol, effectiveSlippage);
      } catch (jupiterError) {
        logger.error(`Jupiter SDK swap failed: ${jupiterError.message}`);
        
        // If Jupiter SDK fails and we have fallback options enabled, try them
        if (options.useFallbacks !== false) {
          // Try direct swap as fallback
          try {
            logger.info(`Trying direct swap as fallback`);
            const keypair = wallet.getKeypair();
            const amountInLamports = Math.floor(amountInSol * 1e9);
            const slippageBps = Math.floor(effectiveSlippage * 100);
            
            return await this.executeDirectSwap(
              'So11111111111111111111111111111111111111112', // Wrapped SOL
              tokenAddress,
              amountInLamports,
              slippageBps,
              keypair,
              { preferredDex: options.preferredDex }
            );
          } catch (directSwapError) {
            logger.error(`Direct swap fallback failed: ${directSwapError.message}`);
            
            // If direct swap fails and Raydium is enabled, try it as a last resort
            if (this.useRaydiumFallback && raydiumClient) {
              try {
                logger.info(`Trying Raydium as last resort fallback`);
                const raydiumResult = await this._executeRaydiumDirectSwap(
                  'So11111111111111111111111111111111111111112',
                  tokenAddress,
                  Math.floor(amountInSol * 1e9),
                  Math.floor(effectiveSlippage * 100),
                  wallet.getKeypair()
                );
                
                if (raydiumResult) {
                  return raydiumResult;
                }
              } catch (raydiumError) {
                logger.error(`Raydium fallback also failed: ${raydiumError.message}`);
              }
            }
          }
        }
        
        // If all fallbacks fail, rethrow the original Jupiter error
        throw jupiterError;
      }
    } catch (error) {
      logger.error(`Error in executeSwap: ${error.message}`);
      throw error;
    }
  }

  /**
   * Execute a swap using Jupiter API SDK directly
   * @param {string} tokenAddress - The mint address of the token to buy
   * @param {number} amountInSol - Amount of SOL to spend
   * @param {number} slippage - The slippage tolerance as a decimal (e.g., 0.05 = 5%)
   * @returns {Promise<Object>} - The swap result
   */
  async executeJupiterApiSwap(tokenAddress, amountInSol, slippage = null) {
    try {
      // Import Jupiter API SDK
      const jupiterApi = require('@jup-ag/api');
      
      const slippageBps = Math.floor((slippage || this.defaultSlippage) * 100);
      const slippagePercent = slippageBps / 100;
      const amountInLamports = Math.floor(amountInSol * 1e9);
      const keypair = wallet.getKeypair();
      
      logger.info(`Executing Jupiter API SDK swap for ${tokenAddress} with ${amountInSol} SOL (slippage: ${slippagePercent}%)`);
      
      // Define input and output tokens
      const inputMint = 'So11111111111111111111111111111111111111112'; // Wrapped SOL
      const outputMint = tokenAddress;
      
      // Always get the latest connection from the RPC manager
      this.connection = this.rpcManager.getCurrentConnection();
      
      // Initialize Jupiter API client
      const jupiterQuoteApi = jupiterApi.createJupiterApiClient({
        connection: this.connection,
        cluster: 'mainnet-beta',
      });
      
      logger.info(`Jupiter API SDK initialized successfully`);
      
      // Step 1: Get quote with progressively higher slippage if needed
      let quote = null;
      const slippageValues = [slippagePercent, 10, 25, 50]; // Try with original slippage, then 10%, 25%, 50%
      
      for (const currentSlippage of slippageValues) {
        try {
          logger.info(`Trying to get quote with ${currentSlippage}% slippage`);
          
          // Get quote
          const quoteResponse = await jupiterQuoteApi.quoteGet({
            inputMint,
            outputMint,
            amount: amountInLamports.toString(),
            slippageBps: Math.floor(currentSlippage * 100), // Convert percentage to basis points
            onlyDirectRoutes: false,
            asLegacyTransaction: false,
            maxAccounts: 10, // Limit the number of accounts to keep transaction size manageable
          });
          
          if (quoteResponse && quoteResponse.data) {
            quote = quoteResponse.data;
            logger.info(`Found quote with ${currentSlippage}% slippage`);
            logger.info(`Quote output amount: ${quote.outAmount} tokens`);
            break;
          } else {
            logger.warn(`No quote found with ${currentSlippage}% slippage`);
          }
        } catch (error) {
          logger.warn(`Error finding quote with ${currentSlippage}% slippage: ${error.message}`);
        }
      }
      
      // If still no quote, try with direct routes only
      if (!quote) {
        try {
          logger.info(`Trying with direct routes only and 50% slippage`);
          
          const quoteResponse = await jupiterQuoteApi.quoteGet({
            inputMint,
            outputMint,
            amount: amountInLamports.toString(),
            slippageBps: 5000, // 50% slippage
            onlyDirectRoutes: true, // Direct routes only
            asLegacyTransaction: false,
          });
          
          if (quoteResponse && quoteResponse.data) {
            quote = quoteResponse.data;
            logger.info(`Found direct route quote with 50% slippage`);
            logger.info(`Direct route quote output: ${quote.outAmount} tokens`);
          } else {
            logger.warn(`No direct route quote found with 50% slippage`);
          }
        } catch (error) {
          logger.warn(`Error finding direct route quote: ${error.message}`);
        }
      }
      
      if (!quote) {
        throw new Error('Could not find any quotes on Jupiter for this token');
      }
      
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
      
      logger.info(`Jupiter API SDK swap transaction confirmed: ${txid}`);
      
      // Extract output amount from the quote
      const outputAmount = Number(quote.outAmount) / Math.pow(10, quote.outputDecimals || 9);
      
      // Get approximate USD value (this is simplified)
      const outputAmountUsd = amountInSol * 10; // Placeholder, replace with actual price data
      
      const result = {
        success: true,
        inputAmount: amountInSol,
        outputAmount: outputAmount,
        outputAmountUsd: outputAmountUsd,
        txHash: txid,
        timestamp: Date.now(),
        provider: 'jupiterApiSdk'
      };
      
      // Log the trade in database
      await this.logTrade(tokenAddress, result);
      
      logger.info(`Jupiter API SDK swap executed successfully: ${result.txHash}`);
      return result;
    } catch (error) {
      logger.error(`Error executing Jupiter API SDK swap: ${error.message}`);
      
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
   * Log a trade to the database
   * @param {string} tokenAddress - The token address
   * @param {Object} swapResult - The swap result
   */
  async logTrade(tokenAddress, swapResult) {
    try {
      // Implement trade logging logic here
      logger.info(`Logged trade for ${tokenAddress}: ${JSON.stringify(swapResult)}`);
      return true;
    } catch (error) {
      logger.error(`Error logging trade: ${error.message}`);
      return false;
    }
  }

  /**
   * Generate a swap transaction from a quote response
   * @param {Object} quoteResponse - The quote response
   * @param {string} userPublicKey - The user's public key
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} - The swap transaction
   */
  async getSwapTransaction(quoteResponse, userPublicKey, options = {}) {
    try {
      logger.info(`Generating swap transaction for user: ${userPublicKey}`);
      
      // Check if the quote came from Raydium or PumpSwap
      if (quoteResponse.provider === 'raydium' && raydiumClient && this.useRaydiumFallback) {
        try {
          logger.info(`Using Raydium to generate swap transaction`);
          const raydiumSwap = await raydiumClient.getSwapTransaction({
            quote: quoteResponse,
            userPublicKey
          });
          
          if (raydiumSwap && raydiumSwap.transaction) {
            logger.info(`Raydium swap transaction generated successfully`);
            return {
              transaction: raydiumSwap.transaction,
              serializedTransaction: raydiumSwap.serializedTransaction,
              provider: 'raydium',
              ...raydiumSwap
            };
          }
        } catch (raydiumError) {
          logger.error(`Error generating Raydium swap transaction: ${raydiumError.message}`);
          // Fall back to ApeJupiter if possible
        }
      }
      
      // Check if the quote came from PumpSwap
      if (quoteResponse.provider === 'pumpswap' && pumpSwapClient && this.usePumpSwapFallback) {
        try {
          logger.info(`Using PumpSwap to generate swap transaction`);
          const pumpSwapSwap = await pumpSwapClient.getSwapTransaction({
            quote: quoteResponse,
            userPublicKey
          });
          
          if (pumpSwapSwap && pumpSwapSwap.transaction) {
            logger.info(`PumpSwap swap transaction generated successfully`);
            return {
              transaction: pumpSwapSwap.transaction,
              serializedTransaction: pumpSwapSwap.serializedTransaction,
              provider: 'pumpswap',
              ...pumpSwapSwap
            };
          }
        } catch (pumpSwapError) {
          logger.error(`Error generating PumpSwap swap transaction: ${pumpSwapError.message}`);
          // Fall back to ApeJupiter if possible
        }
      }
      
      // If the quote is from ApeJupiter or fallbacks failed, use ApeJupiter
      const swapRequest = {
        quoteResponse: quoteResponse.provider === 'apejupiter' ? quoteResponse : undefined,
        userPublicKey,
        // ApeJupiter specific parameters
        wrapUnwrapSOL: true,
        // Enable MEV protection if configured
        ...(this.useMevProtection && { platform: 'jito' })
      };
      
      // If we're using a non-ApeJupiter quote, we need to get a new quote from ApeJupiter
      if (quoteResponse.provider !== 'apejupiter') {
        logger.info(`Getting new ApeJupiter quote for swap transaction`);
        try {
          const newQuote = await this.getQuote(
            quoteResponse.inputMint,
            quoteResponse.outputMint,
            quoteResponse.inAmount || quoteResponse.amount,
            quoteResponse.slippageBps
          );
          swapRequest.quoteResponse = newQuote;
        } catch (quoteError) {
          logger.error(`Failed to get new ApeJupiter quote: ${quoteError.message}`);
          throw new Error(`Cannot generate swap transaction: ${quoteError.message}`);
        }
      }
      
      const response = await this.api.post('/swap', swapRequest);
      
      if (!response.data || !response.data.swapTransaction) {
        throw new Error('Invalid swap response from ApeJupiter');
      }
      
      // Deserialize the transaction
      const serializedTransaction = response.data.swapTransaction;
      let transaction;
      
      logger.info(`Received serialized transaction from ApeJupiter, length: ${serializedTransaction.length}`);
      
      try {
        // First try to deserialize as a versioned transaction
        const buffer = Buffer.from(serializedTransaction, 'base64');
        transaction = VersionedTransaction.deserialize(buffer);
        logger.info(`Successfully deserialized as a versioned transaction, version: ${transaction.version}`);
        
        // Log some details about the transaction
        if (transaction.message) {
          logger.info(`Transaction has ${transaction.message.header ? 'header' : 'no header'} and ${transaction.signatures ? transaction.signatures.length : 0} signatures`);
        }
      } catch (versionedError) {
        // If that fails, try as a regular transaction
        logger.info(`Not a versioned transaction: ${versionedError.message}`);
        try {
          transaction = Transaction.from(Buffer.from(serializedTransaction, 'base64'));
          logger.info('Successfully deserialized as a regular transaction');
        } catch (regularError) {
          logger.error(`Failed to deserialize transaction: ${regularError.message}`);
          throw new Error(`Could not deserialize transaction: ${regularError.message}`);
        }
      }
      
      logger.info(`ApeJupiter swap transaction generated successfully`);
      return {
        transaction,
        serializedTransaction,
        provider: 'apejupiter',
        // Include other useful data from the response
        ...response.data
      };
    } catch (error) {
      logger.error(`Error generating swap transaction: ${error.message}`);
      if (error.response) {
        logger.error(`API error: ${JSON.stringify(error.response.data)}`);
      }
      
      // If ApeJupiter fails and we haven't tried Raydium yet, try it as fallback
      if (this.useRaydiumFallback && raydiumClient && quoteResponse.provider !== 'raydium') {
        try {
          logger.info(`Trying Raydium as fallback for swap transaction`);
          // First get a Raydium quote
          const raydiumQuote = await raydiumClient.getQuote({
            inputMint: quoteResponse.inputMint,
            outputMint: quoteResponse.outputMint,
            amount: quoteResponse.inAmount || quoteResponse.amount,
            slippageBps: quoteResponse.slippageBps
          });
          
          if (raydiumQuote && raydiumQuote.success) {
            // Then get the swap transaction
            const raydiumSwap = await raydiumClient.getSwapTransaction({
              quote: raydiumQuote,
              userPublicKey
            });
            
            if (raydiumSwap && raydiumSwap.transaction) {
              logger.info(`Raydium fallback swap transaction generated successfully`);
              return {
                transaction: raydiumSwap.transaction,
                serializedTransaction: raydiumSwap.serializedTransaction,
                provider: 'raydium',
                ...raydiumSwap
              };
            }
          }
        } catch (raydiumError) {
          logger.error(`Raydium fallback also failed: ${raydiumError.message}`);
        }
      }
      
      // If Raydium fails or is disabled and we haven't tried PumpSwap yet, try it as fallback
      if (this.usePumpSwapFallback && pumpSwapClient && quoteResponse.provider !== 'pumpswap') {
        try {
          logger.info(`Trying PumpSwap as fallback for swap transaction`);
          // First get a PumpSwap quote
          const pumpSwapQuote = await pumpSwapClient.getQuote({
            inputMint: quoteResponse.inputMint,
            outputMint: quoteResponse.outputMint,
            amount: quoteResponse.inAmount || quoteResponse.amount,
            slippageBps: quoteResponse.slippageBps
          });
          
          if (pumpSwapQuote && pumpSwapQuote.success) {
            // Then get the swap transaction
            const pumpSwapSwap = await pumpSwapClient.getSwapTransaction({
              quote: pumpSwapQuote,
              userPublicKey
            });
            
            if (pumpSwapSwap && pumpSwapSwap.transaction) {
              logger.info(`PumpSwap fallback swap transaction generated successfully`);
              return {
                transaction: pumpSwapSwap.transaction,
                serializedTransaction: pumpSwapSwap.serializedTransaction,
                provider: 'pumpswap',
                ...pumpSwapSwap
              };
            }
          }
        } catch (pumpSwapError) {
          logger.error(`PumpSwap fallback also failed: ${pumpSwapError.message}`);
        }
      }
      
      throw error;
    }
  }
}

// Export both the class and a default instance
module.exports = {
  ApeJupiterClient,
  default: new ApeJupiterClient()
};