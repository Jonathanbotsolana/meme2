/**
 * This script demonstrates how to implement exponential backoff for RPC requests
 * to reduce 429 Too Many Requests errors.
 */

const { Connection } = require('@solana/web3.js');

/**
 * Creates a connection wrapper with exponential backoff retry logic
 * @param {string|string[]} endpoints - RPC endpoint(s) to use
 * @param {Object} options - Configuration options
 * @returns {Object} - Enhanced connection object
 */
function createEnhancedConnection(endpoints, options = {}) {
  // Default options
  const config = {
    maxRetries: options.maxRetries || 10,
    baseDelay: options.baseDelay || 500,
    maxDelay: options.maxDelay || 30000,
    jitterFactor: options.jitterFactor || 0.1,
    ...options
  };

  // Convert single endpoint to array
  const endpointList = Array.isArray(endpoints) ? endpoints : [endpoints];
  let currentEndpointIndex = 0;

  // Create connection with first endpoint
  let connection = new Connection(endpointList[0], 'confirmed');

  /**
   * Rotates to the next available RPC endpoint
   */
  function rotateEndpoint() {
    currentEndpointIndex = (currentEndpointIndex + 1) % endpointList.length;
    const newEndpoint = endpointList[currentEndpointIndex];
    console.log(`Rotating RPC endpoint to ${newEndpoint}`);
    connection = new Connection(newEndpoint, 'confirmed');
    return connection;
  }

  /**
   * Calculates delay with exponential backoff and jitter
   * @param {number} retryCount - Current retry attempt
   * @returns {number} - Delay in milliseconds
   */
  function calculateBackoff(retryCount) {
    // Exponential backoff: baseDelay * 2^retryCount
    const exponentialDelay = config.baseDelay * Math.pow(2, retryCount);
    
    // Add jitter to prevent thundering herd problem
    const jitter = Math.random() * exponentialDelay * config.jitterFactor;
    
    // Apply maximum delay cap
    return Math.min(exponentialDelay + jitter, config.maxDelay);
  }

  /**
   * Executes an RPC method with retry logic
   * @param {string} methodName - Name of the connection method to call
   * @param {Array} args - Arguments to pass to the method
   * @returns {Promise<any>} - Result of the RPC call
   */
  async function executeWithRetry(methodName, args = []) {
    let retryCount = 0;
    let lastError = null;
    let endpointRotationCount = 0;

    while (retryCount < config.maxRetries) {
      try {
        // Execute the RPC method
        return await connection[methodName](...args);
      } catch (error) {
        lastError = error;
        
        // Handle different error types
        if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
          retryCount++;
          const delay = calculateBackoff(retryCount);
          console.log(`Server responded with 429 Too Many Requests. Retrying after ${delay}ms delay...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } 
        else if (error.message.includes('timeout') || error.message.includes('timed out')) {
          // For timeout errors, rotate endpoint first
          if (endpointRotationCount < endpointList.length) {
            endpointRotationCount++;
            rotateEndpoint();
            // Don't increase retry count when rotating endpoints
            console.log(`RPC request timeout. Rotating endpoint and retrying...`);
          } else {
            // If we've tried all endpoints, then use backoff
            retryCount++;
            const delay = calculateBackoff(retryCount);
            console.log(`All endpoints timed out. Retrying after ${delay}ms delay...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        } 
        else {
          // For other errors, increment retry count and use backoff
          retryCount++;
          const delay = calculateBackoff(retryCount);
          console.log(`RPC error: ${error.message}. Retrying after ${delay}ms delay...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // If we've exhausted all retries, throw the last error
    console.error(`Maximum retry attempts (${config.maxRetries}) reached. Last error: ${lastError.message}`);
    throw lastError;
  }

  // Create a proxy to intercept all connection method calls
  return new Proxy(connection, {
    get(target, prop) {
      // If the property is a function on the Connection object
      if (typeof target[prop] === 'function' && !prop.startsWith('_')) {
        // Return a wrapped function with retry logic
        return (...args) => executeWithRetry(prop, args);
      }
      // Otherwise return the original property
      return target[prop];
    }
  });
}

/**
 * Example usage:
 */

/*
// Multiple endpoints for rotation
const rpcEndpoints = [
  'https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY',
  'https://solana-mainnet.rpc.extrnode.com',
  'https://api.mainnet-beta.solana.com'
];

// Create enhanced connection
const connection = createEnhancedConnection(rpcEndpoints, {
  maxRetries: 8,
  baseDelay: 500,
  maxDelay: 15000
});

// Use it just like a regular connection
async function getBalance(publicKey) {
  try {
    // This will automatically use retry logic if needed
    const balance = await connection.getBalance(publicKey);
    console.log(`Balance: ${balance}`);
    return balance;
  } catch (error) {
    console.error(`Failed to get balance: ${error.message}`);
  }
}
*/

module.exports = { createEnhancedConnection };