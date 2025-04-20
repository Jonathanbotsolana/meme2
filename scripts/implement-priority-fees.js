/**
 * This script demonstrates how to implement priority fees for transactions
 * to improve transaction confirmation during network congestion.
 */

const { 
  Connection, 
  Transaction, 
  ComputeBudgetProgram,
  PublicKey
} = require('@solana/web3.js');

/**
 * Adds priority fee to a transaction
 * @param {Transaction} transaction - The transaction to add priority fee to
 * @param {number} priorityFee - Priority fee in micro-lamports per compute unit
 * @returns {Transaction} - Transaction with priority fee instruction added
 */
function addPriorityFee(transaction, priorityFee) {
  // Add compute unit price instruction at the beginning of the transaction
  transaction.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFee
    })
  );
  return transaction;
}

/**
 * Adds compute unit limit to a transaction
 * @param {Transaction} transaction - The transaction to add compute unit limit to
 * @param {number} computeUnitLimit - Maximum compute units for the transaction
 * @returns {Transaction} - Transaction with compute unit limit instruction added
 */
function setComputeUnitLimit(transaction, computeUnitLimit) {
  // Add compute unit limit instruction at the beginning of the transaction
  transaction.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnitLimit
    })
  );
  return transaction;
}

/**
 * Dynamically calculates priority fee based on recent priority fee levels
 * @param {Connection} connection - Solana connection
 * @param {Object} options - Configuration options
 * @returns {Promise<number>} - Recommended priority fee in micro-lamports
 */
async function calculateDynamicPriorityFee(connection, options = {}) {
  const config = {
    percentile: options.percentile || 75, // Use 75th percentile by default
    maxSamples: options.maxSamples || 20, // Number of recent blocks to analyze
    multiplier: options.multiplier || 1.1, // Multiply by 1.1x to ensure priority
    minFee: options.minFee || 1000, // Minimum fee (1,000 micro-lamports)
    maxFee: options.maxFee || 1000000, // Maximum fee (1,000,000 micro-lamports = 0.001 SOL)
    ...options
  };

  try {
    // Get recent prioritization fees
    const recentBlocks = await connection.getRecentPrioritizationFees();
    
    if (!recentBlocks || recentBlocks.length === 0) {
      console.log('No recent prioritization fees available, using default minimum fee');
      return config.minFee;
    }

    // Limit the number of samples
    const samples = recentBlocks.slice(0, config.maxSamples);

    // Extract just the prioritization fees
    const fees = samples.map(item => item.prioritizationFee);
    
    // Sort fees in ascending order
    fees.sort((a, b) => a - b);

    // Calculate the specified percentile
    const index = Math.min(
      Math.floor(fees.length * (config.percentile / 100)),
      fees.length - 1
    );
    const percentileFee = fees[index];

    // Apply multiplier and clamp between min and max
    const recommendedFee = Math.min(
      Math.max(Math.ceil(percentileFee * config.multiplier), config.minFee),
      config.maxFee
    );

    console.log(`Calculated dynamic priority fee: ${recommendedFee} micro-lamports`);
    return recommendedFee;
  } catch (error) {
    console.error(`Error calculating dynamic priority fee: ${error.message}`);
    return config.minFee; // Fall back to minimum fee on error
  }
}

/**
 * Creates a transaction with dynamic priority fee
 * @param {Connection} connection - Solana connection
 * @param {Array} instructions - Transaction instructions
 * @param {PublicKey} feePayer - Fee payer public key
 * @param {Object} options - Priority fee options
 * @returns {Promise<Transaction>} - Transaction with priority fee
 */
async function createTransactionWithPriorityFee(connection, instructions, feePayer, options = {}) {
  // Calculate dynamic priority fee if not provided
  const priorityFee = options.priorityFee || await calculateDynamicPriorityFee(connection, options);
  
  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  
  // Create transaction
  const transaction = new Transaction({
    feePayer,
    blockhash,
    lastValidBlockHeight
  });
  
  // Add instructions
  transaction.add(...instructions);
  
  // Add priority fee
  addPriorityFee(transaction, priorityFee);
  
  // Set compute unit limit if provided
  if (options.computeUnitLimit) {
    setComputeUnitLimit(transaction, options.computeUnitLimit);
  }
  
  return transaction;
}

/**
 * Adaptive priority fee manager that adjusts fees based on confirmation success
 */
class AdaptivePriorityFeeManager {
  constructor(options = {}) {
    this.config = {
      baseFee: options.baseFee || 5000, // Starting fee (5,000 micro-lamports)
      maxFee: options.maxFee || 1000000, // Maximum fee (1,000,000 micro-lamports)
      increaseRate: options.increaseRate || 1.5, // Multiply by 1.5x on failure
      decreaseRate: options.decreaseRate || 0.9, // Multiply by 0.9x on success
      successThreshold: options.successThreshold || 3, // Number of consecutive successes before decreasing
      ...options
    };
    
    this.currentFee = this.config.baseFee;
    this.consecutiveSuccesses = 0;
  }
  
  /**
   * Gets the current recommended priority fee
   * @returns {number} - Current priority fee in micro-lamports
   */
  getCurrentFee() {
    return this.currentFee;
  }
  
  /**
   * Notifies the manager of a successful transaction
   */
  notifySuccess() {
    this.consecutiveSuccesses++;
    
    // Only decrease fee after reaching success threshold
    if (this.consecutiveSuccesses >= this.config.successThreshold) {
      this.currentFee = Math.max(
        Math.floor(this.currentFee * this.config.decreaseRate),
        this.config.baseFee
      );
      this.consecutiveSuccesses = 0;
      console.log(`Decreased priority fee to ${this.currentFee} micro-lamports after consecutive successes`);
    }
  }
  
  /**
   * Notifies the manager of a failed transaction
   */
  notifyFailure() {
    // Reset consecutive successes counter
    this.consecutiveSuccesses = 0;
    
    // Increase the fee
    this.currentFee = Math.min(
      Math.ceil(this.currentFee * this.config.increaseRate),
      this.config.maxFee
    );
    
    console.log(`Increased priority fee to ${this.currentFee} micro-lamports after failure`);
  }
  
  /**
   * Resets the manager to initial state
   */
  reset() {
    this.currentFee = this.config.baseFee;
    this.consecutiveSuccesses = 0;
    console.log(`Reset priority fee to base value: ${this.currentFee} micro-lamports`);
  }
}

/**
 * Example usage:
 */

/*
// Create a connection
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

// Create an adaptive fee manager
const feeManager = new AdaptivePriorityFeeManager({
  baseFee: 10000,  // 10,000 micro-lamports
  maxFee: 500000   // 500,000 micro-lamports
});

// Example function to send a transaction with adaptive priority fees
async function sendTransactionWithAdaptiveFee(connection, instructions, feePayer, signers) {
  try {
    // Get current fee from manager
    const priorityFee = feeManager.getCurrentFee();
    
    // Create transaction with priority fee
    const transaction = await createTransactionWithPriorityFee(
      connection,
      instructions,
      feePayer,
      { priorityFee, computeUnitLimit: 200000 }
    );
    
    // Sign transaction
    if (signers?.length) {
      transaction.sign(...signers);
    }
    
    // Send transaction
    const signature = await connection.sendRawTransaction(transaction.serialize());
    
    // Wait for confirmation
    const confirmation = await connection.confirmTransaction(signature);
    
    if (confirmation.value.err) {
      feeManager.notifyFailure();
      throw new Error(`Transaction failed: ${confirmation.value.err}`);
    }
    
    // Transaction succeeded
    feeManager.notifySuccess();
    return signature;
  } catch (error) {
    // Transaction failed
    feeManager.notifyFailure();
    throw error;
  }
}
*/

module.exports = {
  addPriorityFee,
  setComputeUnitLimit,
  calculateDynamicPriorityFee,
  createTransactionWithPriorityFee,
  AdaptivePriorityFeeManager
};