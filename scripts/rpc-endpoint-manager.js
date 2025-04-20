/**
 * Advanced RPC Endpoint Manager for Solana
 * 
 * This module provides robust RPC endpoint management with:
 * - Health monitoring
 * - Automatic failover
 * - Load balancing
 * - Rate limit tracking
 * - Performance metrics
 * - Tiered endpoint prioritization
 * - Exponential backoff with jitter
 */

const { Connection, clusterApiUrl } = require('@solana/web3.js');

class RpcEndpointManager {
  constructor(options = {}) {
    // Default configuration
    this.config = {
      endpoints: options.endpoints || [clusterApiUrl('mainnet-beta')],
      healthCheckInterval: options.healthCheckInterval || 60000, // 1 minute
      healthCheckTimeout: options.healthCheckTimeout || 5000, // 5 seconds
      failedRetryDelay: options.failedRetryDelay || 300000, // 5 minutes
      rotationStrategy: options.rotationStrategy || 'performance-first', // Changed default to performance-first
      commitmentLevel: options.commitmentLevel || 'confirmed',
      debug: options.debug || false,
      maxRetries: options.maxRetries || 5,
      backoffMultiplier: options.backoffMultiplier || 1.5,
      initialBackoff: options.initialBackoff || 500,
      maxBackoff: options.maxBackoff || 10000,
      ...options
    };

    // Initialize endpoint states
    this.endpointStates = this.config.endpoints.map(endpoint => ({
      url: endpoint,
      healthy: true,
      lastHealthCheck: 0,
      failedSince: null,
      responseTime: [], // Last 10 response times in ms
      rateLimited: false,
      rateLimitedUntil: 0,
      errorCount: 0,
      successCount: 0,
      totalRequests: 0,
      tier: this.determineEndpointTier(endpoint) // Add tier information
    }));

    // Current endpoint index
    this.currentIndex = 0;

    // Connection object for current endpoint
    this.connection = new Connection(
      this.endpointStates[this.currentIndex].url,
      this.config.commitmentLevel
    );

    // Start health check interval
    if (this.config.healthCheckInterval > 0) {
      this.startHealthChecks();
    }

    this.log('RPC Endpoint Manager initialized with', this.endpointStates.length, 'endpoints');
  }

  /**
   * Logs messages if debug is enabled
   */
  log(...args) {
    if (this.config.debug) {
      console.log('[RpcEndpointManager]', ...args);
    }
  }

  /**
   * Starts periodic health checks
   */
  startHealthChecks() {
    this.healthCheckInterval = setInterval(
      () => this.checkAllEndpoints(),
      this.config.healthCheckInterval
    );
    this.log('Started health checks with interval:', this.config.healthCheckInterval, 'ms');
  }

  /**
   * Stops periodic health checks
   */
  stopHealthChecks() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      this.log('Stopped health checks');
    }
  }

  /**
   * Checks health of all endpoints
   */
  async checkAllEndpoints() {
    this.log('Performing health check on all RPC endpoints');
    
    const now = Date.now();
    
    // Check each endpoint
    for (let i = 0; i < this.endpointStates.length; i++) {
      const state = this.endpointStates[i];
      
      // Skip recently checked healthy endpoints
      if (state.healthy && now - state.lastHealthCheck < this.config.healthCheckInterval / 2) {
        continue;
      }
      
      // Check if it's time to retry a failed endpoint
      if (!state.healthy && state.failedSince) {
        const failedDuration = now - state.failedSince;
        if (failedDuration < this.config.failedRetryDelay) {
          continue;
        }
      }
      
      // Perform health check
      await this.checkEndpointHealth(i);
    }
    
    // Update current endpoint if needed
    this.selectBestEndpoint();
  }

  /**
   * Checks health of a specific endpoint
   * @param {number} index - Index of the endpoint to check
   */
  async checkEndpointHealth(index) {
    const state = this.endpointStates[index];
    const url = state.url;
    
    this.log('Checking health of endpoint:', url);
    
    try {
      // Create a temporary connection for health check
      const tempConnection = new Connection(url, this.config.commitmentLevel);
      
      // Set timeout for health check
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Health check timeout')), this.config.healthCheckTimeout);
      });
      
      // Perform health check with timeout
      const startTime = Date.now();
      await Promise.race([
        tempConnection.getRecentBlockhash('finalized'),
        timeoutPromise
      ]);
      
      // Calculate response time
      const responseTime = Date.now() - startTime;
      
      // Update endpoint state
      state.healthy = true;
      state.lastHealthCheck = Date.now();
      state.failedSince = null;
      state.responseTime.push(responseTime);
      if (state.responseTime.length > 10) {
        state.responseTime.shift(); // Keep only last 10 measurements
      }
      
      this.log(`Endpoint ${url} is healthy (${responseTime}ms)`);
    } catch (error) {
      // Mark endpoint as unhealthy
      const wasHealthy = state.healthy;
      state.healthy = false;
      state.lastHealthCheck = Date.now();
      if (!state.failedSince) {
        state.failedSince = Date.now();
      }
      state.errorCount++;
      
      const errorMessage = error.message || String(error);
      
      // Determine retry delay based on error type
      let retryDelay = this.config.failedRetryDelay;
      
      if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
        // For authentication errors, use a longer retry delay
        retryDelay = 3600000; // 1 hour
      } else if (errorMessage.includes('429') || errorMessage.includes('Too Many Requests')) {
        // For rate limit errors
        retryDelay = 600000; // 10 minutes
      }
      
      this.log(`Endpoint ${url} health check failed: ${errorMessage}`);
      
      // If this was a previously healthy endpoint, log a warning
      if (wasHealthy) {
        console.warn(`[WARN] Marked endpoint ${url} as failed, will retry after ${retryDelay / 1000} seconds`);
      }
      
      // If this is the current endpoint, rotate to another one
      if (index === this.currentIndex) {
        this.rotateEndpoint();
      }
    }
  }

  /**
   * Calculates average response time for an endpoint
   * @param {number} index - Index of the endpoint
   * @returns {number} - Average response time in ms
   */
  getAverageResponseTime(index) {
    const state = this.endpointStates[index];
    if (state.responseTime.length === 0) return Infinity;
    
    const sum = state.responseTime.reduce((a, b) => a + b, 0);
    return sum / state.responseTime.length;
  }

  /**
   * Determines the tier of an endpoint based on its URL
   * Higher tier endpoints generally have better performance and higher rate limits
   * @param {string} url - The endpoint URL
   * @returns {number} - Tier level (1-3, where 3 is highest)
   */
  determineEndpointTier(url) {
    // Tier 3: Premium paid endpoints
    if (url.includes('quiknode') || 
        url.includes('helius') || 
        url.includes('alchemy') || 
        url.includes('api-key') || 
        url.includes('apikey')) {
      return 3;
    }
    // Tier 2: Better public endpoints
    else if (url.includes('genesysgo') || 
             url.includes('serum') || 
             url.includes('project-serum') || 
             url.includes('solana.com')) {
      return 2;
    }
    // Tier 1: Basic public endpoints
    else {
      return 1;
    }
  }

  /**
   * Selects the best endpoint based on the current rotation strategy
   */
  selectBestEndpoint() {
    // Get all healthy endpoints
    const healthyEndpoints = this.endpointStates
      .map((state, index) => ({ state, index }))
      .filter(item => item.state.healthy && 
                      (!item.state.rateLimited || Date.now() > item.state.rateLimitedUntil));
    
    if (healthyEndpoints.length === 0) {
      console.warn('[WARN] No healthy endpoints available, keeping current endpoint');
      return;
    }
    
    let selectedIndex;
    
    switch (this.config.rotationStrategy) {
      case 'health-first':
        // Select the endpoint with the lowest error count
        selectedIndex = healthyEndpoints.reduce((best, current) => {
          return current.state.errorCount < best.state.errorCount ? current : best;
        }, healthyEndpoints[0]).index;
        break;
        
      case 'performance-first':
        // First prioritize by tier, then by response time
        const byTier = [...healthyEndpoints].sort((a, b) => {
          // First sort by tier (higher tier first)
          const tierDiff = b.state.tier - a.state.tier;
          if (tierDiff !== 0) return tierDiff;
          
          // Then by response time (faster first)
          const aTime = this.getAverageResponseTime(a.index);
          const bTime = this.getAverageResponseTime(b.index);
          return aTime - bTime;
        });
        
        selectedIndex = byTier[0].index;
        break;
        
      case 'round-robin':
      default:
        // Just make sure we're using a healthy endpoint
        if (!this.endpointStates[this.currentIndex].healthy || 
            (this.endpointStates[this.currentIndex].rateLimited && 
             Date.now() <= this.endpointStates[this.currentIndex].rateLimitedUntil)) {
          selectedIndex = healthyEndpoints[0].index;
        } else {
          selectedIndex = this.currentIndex;
        }
        break;
    }
    
    // Update current endpoint if needed
    if (selectedIndex !== this.currentIndex) {
      const oldUrl = this.endpointStates[this.currentIndex].url;
      this.currentIndex = selectedIndex;
      this.connection = new Connection(
        this.endpointStates[this.currentIndex].url,
        this.config.commitmentLevel
      );
      
      const newUrl = this.endpointStates[this.currentIndex].url;
      const avgLatency = Math.round(this.getAverageResponseTime(this.currentIndex));
      const successRate = this.endpointStates[this.currentIndex].totalRequests > 0 ?
        Math.round((this.endpointStates[this.currentIndex].successCount / 
                   this.endpointStates[this.currentIndex].totalRequests) * 100) : 100;
      
      console.log(`Switched RPC endpoint from ${oldUrl} to ${newUrl} (Tier: ${this.endpointStates[this.currentIndex].tier}, Success rate: ${successRate}%, Avg latency: ${avgLatency}ms)`);
    }
  }

  /**
   * Rotates to the next healthy endpoint
   * @returns {boolean} - Whether rotation was successful
   */
  rotateEndpoint() {
    // Get all healthy endpoints that aren't rate limited
    const viableIndices = this.endpointStates
      .map((state, index) => ({ state, index }))
      .filter(item => {
        // Check if healthy and not rate limited
        return item.state.healthy && 
               (!item.state.rateLimited || Date.now() > item.state.rateLimitedUntil);
      })
      .map(item => item.index);
    
    // If no viable endpoints, try any healthy endpoint
    if (viableIndices.length === 0) {
      const healthyIndices = this.endpointStates
        .map((state, index) => ({ state, index }))
        .filter(item => item.state.healthy)
        .map(item => item.index);
      
      if (healthyIndices.length === 0) {
        console.warn('[WARN] No healthy endpoints available for rotation. Using least recently failed endpoint.');
        
        // As a last resort, use the endpoint that failed least recently
        const leastRecentlyFailed = this.endpointStates
          .map((state, index) => ({ state, index, failedTime: state.failedSince || Infinity }))
          .sort((a, b) => a.failedTime - b.failedTime)
          .map(item => item.index);
        
        if (leastRecentlyFailed.length > 0 && leastRecentlyFailed[0] !== this.currentIndex) {
          this.currentIndex = leastRecentlyFailed[0];
          this.connection = new Connection(
            this.endpointStates[this.currentIndex].url,
            this.config.commitmentLevel
          );
          
          console.warn(`[WARN] Rotated to least recently failed endpoint: ${this.endpointStates[this.currentIndex].url}`);
          return true;
        }
        
        return false;
      }
      
      // Use the first healthy endpoint
      this.currentIndex = healthyIndices[0];
    } else {
      // Find the next viable endpoint after the current one
      let nextIndex = this.currentIndex;
      let iterations = 0;
      const maxIterations = this.endpointStates.length; // Prevent infinite loop
      
      do {
        nextIndex = (nextIndex + 1) % this.endpointStates.length;
        iterations++;
      } while (!viableIndices.includes(nextIndex) && 
               iterations < maxIterations && 
               nextIndex !== this.currentIndex);
      
      // If we couldn't find a viable endpoint, use the first viable one
      if (!viableIndices.includes(nextIndex) || nextIndex === this.currentIndex) {
        nextIndex = viableIndices[0];
      }
      
      this.currentIndex = nextIndex;
    }
    
    // Update connection
    this.connection = new Connection(
      this.endpointStates[this.currentIndex].url,
      this.config.commitmentLevel
    );
    
    console.log(`Rotating RPC endpoint to: ${this.endpointStates[this.currentIndex].url}`);
    return true;
  }

  /**
   * Records a rate limit event for the current endpoint
   * @param {number} retryAfter - Time in ms to wait before retrying (optional)
   */
  recordRateLimit(retryAfter = 60000) { // Increased default retry delay to 60 seconds
    const state = this.endpointStates[this.currentIndex];
    state.rateLimited = true;
    state.rateLimitedUntil = Date.now() + retryAfter;
    state.errorCount++;
    
    console.warn(`[WARN] RPC rate limit hit on ${state.url}. Rotating endpoint and retrying after ${retryAfter/1000} seconds...`);
    
    // Rotate to another endpoint
    this.rotateEndpoint();
  }

  /**
   * Records a successful request for the current endpoint
   * @param {number} responseTime - Response time in ms
   */
  recordSuccess(responseTime) {
    const state = this.endpointStates[this.currentIndex];
    state.successCount++;
    state.totalRequests++;
    
    // Update response time tracking
    state.responseTime.push(responseTime);
    if (state.responseTime.length > 10) {
      state.responseTime.shift();
    }
  }

  /**
   * Records a failed request for the current endpoint
   * @param {Error} error - The error that occurred
   */
  recordFailure(error) {
    const state = this.endpointStates[this.currentIndex];
    state.errorCount++;
    state.totalRequests++;
    
    const errorMsg = error.message || String(error);
    
    // Check if this is a rate limit error
    if (errorMsg.includes('429') || 
        errorMsg.includes('Too Many Requests')) {
      // For rate limit errors, use a longer retry delay
      this.recordRateLimit(120000); // 2 minutes
    }
    // Check if this is a timeout error
    else if (errorMsg.includes('timeout') || 
             errorMsg.includes('timed out')) {
      console.warn(`[WARN] RPC timeout on ${state.url}. Performing health check...`);
      // Perform an immediate health check
      this.checkEndpointHealth(this.currentIndex);
    }
    // Handle other common RPC errors
    else if (errorMsg.includes('fetch failed') ||
             errorMsg.includes('ECONNREFUSED') ||
             errorMsg.includes('ENOTFOUND') ||
             errorMsg.includes('503') ||
             errorMsg.includes('Service Unavailable')) {
      console.warn(`[WARN] RPC connection error on ${state.url}: ${errorMsg}. Marking as unhealthy.`);
      state.healthy = false;
      state.failedSince = Date.now();
      this.rotateEndpoint();
    }
  }

  /**
   * Gets the current connection
   * @returns {Connection} - Solana connection object
   */
  getConnection() {
    return this.connection;
  }

  /**
   * Gets all endpoint statistics
   * @returns {Array} - Array of endpoint statistics
   */
  getEndpointStats() {
    return this.endpointStates.map(state => {
      const avgResponseTime = state.responseTime.length > 0 ? 
        state.responseTime.reduce((a, b) => a + b, 0) / state.responseTime.length : 
        null;
      
      const successRate = state.totalRequests > 0 ? 
        state.successCount / state.totalRequests : 
        1; // Default to 100% if no requests made
      
      return {
        url: state.url,
        tier: state.tier,
        healthy: state.healthy,
        rateLimited: state.rateLimited && Date.now() <= state.rateLimitedUntil,
        rateLimitedFor: state.rateLimited ? 
          Math.max(0, Math.floor((state.rateLimitedUntil - Date.now()) / 1000)) + 's' : 
          'N/A',
        avgResponseTime: avgResponseTime ? Math.round(avgResponseTime) + 'ms' : 'N/A',
        errorRate: state.totalRequests > 0 ? 
          ((state.errorCount / state.totalRequests) * 100).toFixed(1) + '%' : 
          '0%',
        successRate: (successRate * 100).toFixed(1) + '%',
        totalRequests: state.totalRequests,
        lastHealthCheck: state.lastHealthCheck ? 
          new Date(state.lastHealthCheck).toISOString() : 
          'Never',
        isCurrent: this.endpointStates.indexOf(state) === this.currentIndex
      };
    });
  }

  /**
   * Adds a new endpoint to the manager
   * @param {string} url - URL of the new endpoint
   */
  addEndpoint(url) {
    // Check if endpoint already exists
    if (this.endpointStates.some(state => state.url === url)) {
      this.log(`Endpoint ${url} already exists`);
      return false;
    }
    
    // Add new endpoint
    this.endpointStates.push({
      url,
      healthy: true, // Assume healthy until checked
      lastHealthCheck: 0,
      failedSince: null,
      responseTime: [],
      rateLimited: false,
      rateLimitedUntil: 0,
      errorCount: 0,
      successCount: 0,
      totalRequests: 0
    });
    
    this.log(`Added new endpoint: ${url}`);
    
    // Perform immediate health check
    this.checkEndpointHealth(this.endpointStates.length - 1);
    return true;
  }

  /**
   * Removes an endpoint from the manager
   * @param {string} url - URL of the endpoint to remove
   */
  removeEndpoint(url) {
    const index = this.endpointStates.findIndex(state => state.url === url);
    if (index === -1) {
      this.log(`Endpoint ${url} not found`);
      return false;
    }
    
    // Don't remove if it's the only endpoint
    if (this.endpointStates.length === 1) {
      this.log('Cannot remove the only endpoint');
      return false;
    }
    
    // Remove endpoint
    this.endpointStates.splice(index, 1);
    this.log(`Removed endpoint: ${url}`);
    
    // If we removed the current endpoint, rotate to another one
    if (index === this.currentIndex) {
      this.currentIndex = 0;
      this.connection = new Connection(
        this.endpointStates[this.currentIndex].url,
        this.config.commitmentLevel
      );
      this.log('Switched to endpoint:', this.endpointStates[this.currentIndex].url);
    }
    // If we removed an endpoint before the current one, adjust the index
    else if (index < this.currentIndex) {
      this.currentIndex--;
    }
    
    return true;
  }

  /**
   * Creates a wrapped connection that automatically handles endpoint rotation and retries
   * @returns {Object} - Wrapped connection object
   */
  createWrappedConnection() {
    const manager = this;
    
    return new Proxy(this.connection, {
      get(target, prop) {
        // If the property is a function on the Connection object
        if (typeof target[prop] === 'function' && !prop.startsWith('_')) {
          // Return a wrapped function with endpoint management
          return async function(...args) {
            let retries = 0;
            const maxRetries = 5; // Increased from 3 to 5
            let backoffDelay = 500; // Start with 500ms delay
            
            while (retries <= maxRetries) {
              try {
                const startTime = Date.now();
                const result = await manager.connection[prop](...args);
                const responseTime = Date.now() - startTime;
                
                // Record successful request
                manager.recordSuccess(responseTime);
                
                return result;
              } catch (error) {
                // Record failed request
                manager.recordFailure(error);
                
                retries++;
                
                if (retries <= maxRetries) {
                  // Exponential backoff with jitter
                  backoffDelay = Math.min(backoffDelay * 2, 10000); // Cap at 10 seconds
                  const jitter = Math.random() * 0.3 * backoffDelay; // Add up to 30% jitter
                  const delay = backoffDelay + jitter;
                  
                  // Try with a different endpoint
                  manager.rotateEndpoint();
                  console.log(`Request failed, retrying with different endpoint (${retries}/${maxRetries}) after ${Math.round(delay)}ms delay`);
                  
                  // Wait before retrying
                  await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                  throw error;
                }
              }
            }
          };
        }
        
        // Otherwise return the original property
        return target[prop];
      }
    });
  }
}

module.exports = RpcEndpointManager;

/**
 * Example usage:
 */

/*
// Create endpoint manager with multiple endpoints
const manager = new RpcEndpointManager({
  endpoints: [
    // Tier 3 (Premium) endpoints
    'https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY',
    'https://solana-mainnet.rpc.extrnode.com',
    'https://your-project.solana-mainnet.quiknode.pro/YOUR_API_KEY/',
    
    // Tier 2 endpoints
    'https://api.mainnet-beta.solana.com',
    'https://solana-api.projectserum.com',
    
    // Tier 1 endpoints
    'https://rpc.ankr.com/solana',
    'https://solana-mainnet.public.blastapi.io'
  ],
  healthCheckInterval: 60000, // 1 minute
  rotationStrategy: 'performance-first',
  debug: true,
  maxRetries: 5,
  initialBackoff: 500,
  maxBackoff: 10000
});

// Get a connection that automatically handles endpoint rotation
const connection = manager.createWrappedConnection();

// Use it just like a regular connection
async function getBalance(publicKey) {
  try {
    const balance = await connection.getBalance(publicKey);
    console.log(`Balance: ${balance}`);
    return balance;
  } catch (error) {
    console.error(`Failed to get balance: ${error.message}`);
  }
}

// Get endpoint statistics
setInterval(() => {
  console.log('Endpoint Statistics:');
  console.table(manager.getEndpointStats());
}, 300000); // Every 5 minutes
*/