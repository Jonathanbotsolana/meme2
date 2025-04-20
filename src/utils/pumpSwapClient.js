/**
 * PumpSwap Direct Integration Client
 * 
 * This client provides direct integration with PumpSwap for token swaps
 * without relying on Jupiter aggregator.
 */

const { Connection, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { Token, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const logger = require('./logger');
const fetch = require('node-fetch');

class PumpSwapClient {
  constructor() {
    // PumpSwap API endpoints
    this.API_BASE_URL = 'https://api.pump.fun';
    
    // SOL token address
    this.SOL_ADDRESS = 'So11111111111111111111111111111111111111112';
    
    // WSOL token address (wrapped SOL)
    this.WSOL_ADDRESS = 'So11111111111111111111111111111111111111112';
    
    logger.info('PumpSwap direct client initialized');
  }
  
  /**
   * Normalize a token address
   * @param {string} tokenAddress - Token address to normalize
   * @returns {string} - Normalized token address
   */
  normalizeTokenAddress(tokenAddress) {
    try {
      return new PublicKey(tokenAddress).toString();
    } catch (error) {
      throw new Error(`Invalid token address: ${tokenAddress}`);
    }
  }
  
  /**
   * Execute a direct swap using PumpSwap
   * @param {Object} params - Swap parameters
   * @param {string} params.tokenAddress - Token address to swap to
   * @param {string|Object} params.userWallet - User wallet address or keypair
   * @param {number} params.solAmount - SOL amount to swap (in SOL, not lamports)
   * @param {number} params.slippageBps - Slippage in basis points (e.g., 500 = 5%)
   * @param {Object} params.connection - Solana connection object
   * @returns {Promise<{success: boolean, transaction: Object, signature: string, expectedOutput: number, error: string|null}>}
   */
  async executeDirectSwap(params) {
    try {
      const { tokenAddress, userWallet, solAmount = 0.01, slippageBps = 500, connection } = params;
      
      if (!connection) {
        throw new Error('Solana connection object is required');
      }
      
      // Normalize token address
      const normalizedAddress = this.normalizeTokenAddress(tokenAddress);
      
      logger.info(`Executing PumpSwap direct swap for ${normalizedAddress} with ${solAmount} SOL (slippage: ${slippageBps} bps)`);
      
      // Convert SOL to lamports
      const inputAmount = Math.floor(solAmount * 10**9);
      
      // Step 1: Get the swap quote from PumpSwap API
      const quoteResponse = await this.getSwapQuote({
        inputMint: this.SOL_ADDRESS,
        outputMint: normalizedAddress,
        amount: inputAmount,
        slippageBps
      });
      
      if (!quoteResponse || !quoteResponse.success) {
        throw new Error(`Failed to get swap quote: ${quoteResponse?.error || 'Unknown error'}`);
      }
      
      logger.info(`Got PumpSwap quote: ${quoteResponse.outAmount} output tokens expected`);
      
      // Step 2: Build the swap transaction
      const transaction = await this.buildSwapTransaction({
        quote: quoteResponse,
        userWallet,
        connection
      });
      
      // Step 3: Sign and send the transaction
      const keypair = typeof userWallet === 'object' ? userWallet : null;
      if (!keypair) {
        throw new Error('Keypair is required for PumpSwap swap');
      }
      
      logger.info(`Sending PumpSwap transaction...`);
      
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [keypair],
        { commitment: 'confirmed' }
      );
      
      logger.info(`PumpSwap swap transaction confirmed: ${signature}`);
      
      return {
        success: true,
        transaction: {
          signature
        },
        signature,
        expectedOutput: quoteResponse.outAmount,
        error: null
      };
    } catch (error) {
      logger.error(`Error executing PumpSwap direct swap: ${error.message}`);
      
      return {
        success: false,
        transaction: null,
        signature: null,
        expectedOutput: null,
        error: error.message
      };
    }
  }
  
  /**
   * Get a swap quote from PumpSwap API
   * @param {Object} params - Quote parameters
   * @param {string} params.inputMint - Input token mint address
   * @param {string} params.outputMint - Output token mint address
   * @param {number} params.amount - Input amount in lamports
   * @param {number} params.slippageBps - Slippage in basis points
   * @returns {Promise<Object>} - Swap quote
   */
  async getSwapQuote(params) {
    try {
      const { inputMint, outputMint, amount, slippageBps } = params;
      
      const url = `${this.API_BASE_URL}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippage=${slippageBps}`;
      
      logger.info(`Getting PumpSwap quote from: ${url}`);
      
      const response = await fetch(url);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`PumpSwap API error (${response.status}): ${errorText}`);
      }
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(`PumpSwap quote error: ${data.error || 'Unknown error'}`);
      }
      
      return {
        success: true,
        inAmount: data.inAmount,
        outAmount: data.outAmount,
        price: data.price,
        priceImpact: data.priceImpact,
        fee: data.fee,
        routes: data.routes
      };
    } catch (error) {
      logger.error(`Error getting PumpSwap quote: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Build a swap transaction using PumpSwap
   * @param {Object} params - Transaction parameters
   * @param {Object} params.quote - Swap quote from getSwapQuote
   * @param {string|Object} params.userWallet - User wallet address or keypair
   * @param {Object} params.connection - Solana connection object
   * @returns {Promise<Transaction>} - Swap transaction
   */
  async buildSwapTransaction(params) {
    try {
      const { quote, userWallet, connection } = params;
      
      // Get the user's public key
      const userPublicKey = typeof userWallet === 'string' 
        ? new PublicKey(userWallet) 
        : userWallet.publicKey;
      
      // Get the swap transaction from PumpSwap API
      const url = `${this.API_BASE_URL}/swap`;
      
      const requestBody = {
        routes: quote.routes,
        userPublicKey: userPublicKey.toString()
      };
      
      logger.info(`Getting PumpSwap transaction from: ${url}`);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`PumpSwap API error (${response.status}): ${errorText}`);
      }
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(`PumpSwap transaction error: ${data.error || 'Unknown error'}`);
      }
      
      // Deserialize the transaction
      const serializedTx = Buffer.from(data.encodedTransaction, 'base64');
      const transaction = Transaction.from(serializedTx);
      
      // Get a recent blockhash
      const { blockhash } = await connection.getRecentBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = userPublicKey;
      
      return transaction;
    } catch (error) {
      logger.error(`Error building PumpSwap transaction: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new PumpSwapClient();