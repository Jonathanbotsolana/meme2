/**
 * This script demonstrates how to implement RPC request caching
 * to reduce the number of requests and avoid rate limiting.
 */

const { Connection } = require('@solana/web3.js');

/**
 * Creates a connection wrapper with caching capabilities
 * @param {string} endpoint - RPC endpoint to use
 * @param {Object} options - Configuration options
 * @returns {Object} - Enhanced connection object with caching
 */
function createCachedConnection(endpoint, options = {}) {
  // Default options
  const config = {
    defaultTTL: options.defaultTTL || 30000, // 30 seconds default TTL
    cacheSizeLimit: options.cacheSizeLimit || 1000, // Maximum number of cached items
    methodSpecificTTL: options.methodSpecificTTL || {}, // Method-specific TTLs
    ...options
  };

  // Create the connection
  const connection = new Connection(endpoint, 'confirmed');

  // Initialize cache
  const cache = new Map();
  let cacheHits = 0;
  let cacheMisses = 0;

  /**
   * Gets TTL for a specific method
   * @param {string} methodName - The RPC method name
   * @returns {number} - TTL in milliseconds
   */
  function getTTL(methodName) {
    return config.methodSpecificTTL[methodName] || config.defaultTTL;
  }

  /**
   * Creates a cache key from method name and arguments
   * @param {string} methodName - The RPC method name
   * @param {Array} args - Method arguments
   * @returns {string} - Cache key
   */
  function createCacheKey(methodName, args) {
    return `${methodName}:${JSON.stringify(args)}`;
  }

  /**
   * Cleans up old cache entries if cache size exceeds limit
   */
  function cleanupCache() {
    if (cache.size <= config.cacheSizeLimit) return;

    // Sort entries by timestamp (oldest first)
    const entries = Array.from(cache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

    // Remove oldest entries until we're under the limit
    const entriesToRemove = entries.slice(0, entries.length - config.cacheSizeLimit);
    for (const [key] of entriesToRemove) {
      cache.delete(key);
    }
  }

  /**
   * Gets cache statistics
   * @returns {Object} - Cache statistics
   */
  function getCacheStats() {
    return {
      size: cache.size,
      hits: cacheHits,
      misses: cacheMisses,
      hitRatio: cacheHits / (cacheHits + cacheMisses) || 0
    };
  }

  /**
   * Clears the cache
   */
  function clearCache() {
    cache.clear();
    console.log('Cache cleared');
  }

  /**
   * Executes an RPC method with caching
   * @param {string} methodName - Name of the connection method to call
   * @param {Array} args - Arguments to pass to the method
   * @param {boolean} bypassCache - Whether to bypass the cache for this call
   * @returns {Promise<any>} - Result of the RPC call
   */
  async function executeWithCache(methodName, args = [], bypassCache = false) {
    // Methods that should never be cached
    const neverCacheMethods = [
      'sendTransaction',
      'sendRawTransaction',
      'simulateTransaction',
      'requestAirdrop'
    ];

    // Skip caching for write operations or if explicitly bypassed
    if (neverCacheMethods.includes(methodName) || bypassCache) {
      return await connection[methodName](...args);
    }

    const cacheKey = createCacheKey(methodName, args);
    const ttl = getTTL(methodName);
    const now = Date.now();

    // Check if we have a valid cached response
    if (cache.has(cacheKey)) {
      const cachedItem = cache.get(cacheKey);
      if (now - cachedItem.timestamp < ttl) {
        cacheHits++;
        return cachedItem.data;
      }
    }

    // Cache miss, execute the actual RPC call
    cacheMisses++;
    const result = await connection[methodName](...args);

    // Cache the result
    cache.set(cacheKey, {
      data: result,
      timestamp: now
    });

    // Clean up old entries if needed
    cleanupCache();

    return result;
  }

  // Create a proxy to intercept all connection method calls
  const cachedConnection = new Proxy(connection, {
    get(target, prop) {
      // If the property is a function on the Connection object
      if (typeof target[prop] === 'function' && !prop.startsWith('_')) {
        // Return a wrapped function with caching
        return (...args) => {
          // Check if the last argument is an options object with bypassCache
          let bypassCache = false;
          if (args.length > 0 && typeof args[args.length - 1] === 'object') {
            const options = args[args.length - 1];
            if (options.bypassCache) {
              bypassCache = true;
              // Remove the bypassCache property to avoid sending it to the RPC
              delete options.bypassCache;
            }
          }
          return executeWithCache(prop, args, bypassCache);
        };
      }
      // Otherwise return the original property
      return target[prop];
    }
  });

  // Add cache control methods
  cachedConnection.getCacheStats = getCacheStats;
  cachedConnection.clearCache = clearCache;

  return cachedConnection;
}

/**
 * Example usage:
 */

/*
const rpcEndpoint = 'https://api.mainnet-beta.solana.com';

// Create cached connection with custom TTLs for different methods
const connection = createCachedConnection(rpcEndpoint, {
  defaultTTL: 30000, // 30 seconds default
  methodSpecificTTL: {
    'getBalance': 10000, // 10 seconds for balance
    'getTokenAccountsByOwner': 60000, // 1 minute for token accounts
    'getRecentBlockhash': 2000 // 2 seconds for recent blockhash
  }
});

// Use it just like a regular connection
async function getAccountInfo(publicKey) {
  try {
    // This will use cache if available
    const accountInfo = await connection.getAccountInfo(publicKey);
    console.log('Account info retrieved');
    
    // Force bypass cache
    const freshAccountInfo = await connection.getAccountInfo(publicKey, { bypassCache: true });
    console.log('Fresh account info retrieved');
    
    // Check cache stats
    console.log(connection.getCacheStats());
    
    return accountInfo;
  } catch (error) {
    console.error(`Failed to get account info: ${error.message}`);
  }
}
*/

module.exports = { createCachedConnection };