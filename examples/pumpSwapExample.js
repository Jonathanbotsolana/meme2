/**
 * Example usage of PumpSwap Client
 */
const { PublicKey } = require('@solana/web3.js');
const pumpSwapClient = require('../src/utils/pumpSwapClient');

// Example token address (replace with an actual token that has a PumpSwap pool)
const TOKEN_ADDRESS = 'EUdQbKfHucJe99GVt3HQMUZCQtWtvXFyjvrqDWctpump'; // Example token

// Example user wallet (replace with your wallet)
const USER_WALLET = 'YourWalletAddressHere';

// Example function to get pool information
async function getPoolInfo() {
  try {
    console.log(`Getting PumpSwap pool info for ${TOKEN_ADDRESS}...`);
    const pool = await pumpSwapClient.getPoolInfo(TOKEN_ADDRESS);
    
    if (pool) {
      console.log('Pool found:', JSON.stringify(pool, null, 2));
      return pool;
    } else {
      console.log('No pool found for this token');
      return null;
    }
  } catch (error) {
    console.error('Error getting pool info:', error.message);
    return null;
  }
}

// Example function to calculate expected output
async function calculateOutput(pool, solAmount = 0.01) {
  try {
    if (!pool) {
      console.log('No pool provided, trying to get pool info...');
      pool = await pumpSwapClient.getPoolInfo(TOKEN_ADDRESS);
      
      if (!pool) {
        console.log('No pool found for this token');
        return null;
      }
    }
    
    // Convert SOL to lamports
    const inputAmount = Math.floor(solAmount * 10**9);
    
    console.log(`Calculating expected output for ${solAmount} SOL...`);
    const outputInfo = pumpSwapClient.calculateOutput(pool, inputAmount, 500); // 5% slippage
    
    console.log('Output info:', JSON.stringify(outputInfo, null, 2));
    return outputInfo;
  } catch (error) {
    console.error('Error calculating output:', error.message);
    return null;
  }
}

// Example function to create a swap transaction
async function createSwapTransaction(solAmount = 0.01) {
  try {
    console.log(`Creating swap transaction for ${solAmount} SOL...`);
    
    // Convert SOL to lamports
    const inputAmount = Math.floor(solAmount * 10**9);
    
    // Get pool information
    const pool = await pumpSwapClient.getPoolInfo(TOKEN_ADDRESS);
    
    if (!pool) {
      console.log('No pool found for this token');
      return null;
    }
    
    // Calculate expected output
    const outputInfo = pumpSwapClient.calculateOutput(pool, inputAmount, 500); // 5% slippage
    
    // Create transaction
    const transaction = await pumpSwapClient.createSwapTransaction({
      tokenAddress: TOKEN_ADDRESS,
      userWallet: USER_WALLET,
      inputAmount,
      minimumOutput: outputInfo.minimumOutput
    });
    
    if (!transaction) {
      console.log('Failed to create transaction');
      return null;
    }
    
    console.log('Transaction created successfully');
    console.log('Transaction instructions:', transaction.instructions.length);
    
    return transaction;
  } catch (error) {
    console.error('Error creating swap transaction:', error.message);
    return null;
  }
}

// Example function to execute a direct swap
async function executeDirectSwap(solAmount = 0.01) {
  try {
    console.log(`Executing direct swap for ${solAmount} SOL...`);
    
    const result = await pumpSwapClient.executeDirectSwap({
      tokenAddress: TOKEN_ADDRESS,
      userWallet: USER_WALLET,
      solAmount,
      slippageBps: 500 // 5% slippage
    });
    
    console.log('Swap result:', JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error('Error executing direct swap:', error.message);
    return null;
  }
}

// Main function to run examples
async function runExamples() {
  console.log('PumpSwap Client Example');
  console.log('======================');
  
  // Check if token has a pool
  const hasPool = await pumpSwapClient.hasPool(TOKEN_ADDRESS);
  console.log(`Token has PumpSwap pool: ${hasPool}`);
  
  if (hasPool) {
    // Get pool info
    const pool = await getPoolInfo();
    
    // Calculate expected output
    if (pool) {
      await calculateOutput(pool, 0.01);
    }
    
    // Create swap transaction
    await createSwapTransaction(0.01);
    
    // Execute direct swap
    // Note: This will not actually send the transaction
    await executeDirectSwap(0.01);
  } else {
    console.log('No PumpSwap pool found for this token. Examples cannot continue.');
  }
  
  console.log('Examples completed!');
}

// Run the examples
runExamples().catch(error => {
  console.error('Error running examples:', error);
});