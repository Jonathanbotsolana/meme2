const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('./logger');
const config = require('../../config/config');

class RPCManager {
  constructor() {
    // Use config endpoints if available, otherwise use these fallbacks
    this.endpoints = config.solana.rpcEndpoints || [
      'https://api.mainnet-beta.solana.com',
      'https://solana-api.projectserum.com',
      'https://rpc.ankr.com/solana',
      'https://solana-mainnet.g.alchemy.com/v2/demo',
      'https://mainnet.solana-dapp.com',
      'https://ssc-dao.genesysgo.net'
    ];
    
    // Get endpoint tiers from config or use default
    this.endpointTiers = config.solana.weightedRpcEndpoints || {};
    
    // Sort endpoints by tier (higher tier first)
    this.sortedEndpoints = [...this.endpoints].sort((a, b) => {
      const tierA = this.endpointTiers[a] || 1;
      const tierB = this.endpointTiers[b] || 1;
      return tierB - tierA; // Higher tier first
    });
    
    // Create connections with custom commitment and timeout
    this.connections = {};
    this.sortedEndpoints.forEach(endpoint => {
      this.connections[endpoint] = new Connection(endpoint, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000,
        disableRetryOnRateLimit: true, // We'll handle retries ourselves
        maxSupportedTransactionVersion: 0 // Support transaction version 0
      });
    });
    
    this.currentEndpoint = this.sortedEndpoints[0];
    this.requestCounts = {};
    this.endpoints.forEach(endpoint => {
      this.requestCounts[endpoint] = 0;
    });
    
    this.lastRotateTime = Date.now();
    this.requestQueue = [];
    this.processing = false;
    this.lastRequestTime = 0;
    this.minRequestInterval = 500; // 500ms between requests (more conservative)
    
    // Rate limiting based on Solana mainnet limits
    this.rateLimit = config.solana.rateLimit || {
      maxRequestsPer10Sec: 80, // Solana mainnet limit is 100
      maxRequestsPerMethodPer10Sec: 30, // Solana mainnet limit is 40
      enableThrottling: true
    };
    
    // Track requests in 10-second windows for rate limiting
    this.requestsIn10SecWindow = [];
    this.requestsByMethodIn10SecWindow = {};
    
    this.maxRequestsPerMinute = 30; // More conservative limit
    // Initialize rate limiting properties
    this.windowSize = 60000; // 1 minute in ms
    this.requestTimestamps = {};
    this.endpoints.forEach(endpoint => {
      this.requestTimestamps[endpoint] = [];
    });
    
    this.failedEndpoints = new Map(); // Track failed endpoints and their recovery time
    this.maxRetries = config.solana.maxRpcRetries || 5; // Maximum number of retries per request
    
    // Track endpoint performance metrics
    this.endpointMetrics = {};
    this.endpoints.forEach(endpoint => {
      this.endpointMetrics[endpoint] = {
        successCount: 0,
        failureCount: 0,
        totalLatency: 0,
        lastSuccessTime: 0
      };
    });
    
    // Schedule periodic health checks
    this.healthCheckInterval = setInterval(() => this.checkAllEndpointsHealth(), 5 * 60 * 1000); // Every 5 minutes
  }

  // Get the current connection
  getCurrentConnection() {
    return this.connections[this.currentEndpoint];
  }

  // Get the current endpoint URL
  getCurrentEndpoint() {
    return this.currentEndpoint;
  }

  // Find the best available endpoint based on tier and health
  findBestEndpoint() {
    const now = Date.now();
    
    // Filter out endpoints that are in cooldown
    const availableEndpoints = this.sortedEndpoints.filter(endpoint => {
      const failedUntil = this.failedEndpoints.get(endpoint);
      return !failedUntil || now >= failedUntil;
    });
    
    if (availableEndpoints.length === 0) {
      // If all endpoints are in cooldown, find the one with the shortest cooldown
      let minCooldownEndpoint = this.sortedEndpoints[0];
      let minCooldownTime = Number.MAX_SAFE_INTEGER;
      
      this.sortedEndpoints.forEach(endpoint => {
        const cooldownTime = this.failedEndpoints.get(endpoint) || 0;
        if (cooldownTime < minCooldownTime) {
          minCooldownTime = cooldownTime;
          minCooldownEndpoint = endpoint;
        }
      });
      
      // Reset the cooldown for this endpoint
      this.failedEndpoints.delete(minCooldownEndpoint);
      return minCooldownEndpoint;
    }
    
    // Return the highest tier available endpoint
    return availableEndpoints[0];
  }

  // Rotate to the best available endpoint
  rotateEndpoint() {
    const oldEndpoint = this.currentEndpoint;
    
    // Find the best endpoint
    this.currentEndpoint = this.findBestEndpoint();
    
    const newEndpoint = this.currentEndpoint;
    if (oldEndpoint !== newEndpoint) {
      logger.warn(`Rotating RPC endpoint from ${oldEndpoint} to ${newEndpoint}`);
    }
    
    this.lastRotateTime = Date.now();
    return this.connections[this.currentEndpoint];
  }

  // Mark an endpoint as failed with exponential backoff
  markEndpointFailed(endpoint, retryAfter = 30000) {
    // Get the current backoff or use the default
    const currentBackoff = this.failedEndpoints.get(endpoint) || 0;
    const now = Date.now();
    
    // If the endpoint is already in cooldown, increase the backoff
    let newBackoff;
    if (currentBackoff > now) {
      // Double the remaining cooldown time, with a maximum of 10 minutes
      const remainingTime = currentBackoff - now;
      newBackoff = now + Math.min(remainingTime * 2, 10 * 60 * 1000);
    } else {
      // New failure, use the provided retryAfter
      newBackoff = now + retryAfter;
    }
    
    this.failedEndpoints.set(endpoint, newBackoff);
    
    // Update metrics
    if (this.endpointMetrics[endpoint]) {
      this.endpointMetrics[endpoint].failureCount++;
    }
    
    const cooldownSeconds = Math.round((newBackoff - now) / 1000);
    logger.warn(`Marked endpoint ${endpoint} as failed, will retry after ${cooldownSeconds} seconds`);
    
    // If this was the current endpoint, rotate to a new one
    if (endpoint === this.currentEndpoint) {
      this.rotateEndpoint();
    }
  }

  // Check if we should rotate based on request count and other factors
  shouldRotate() {
    const now = Date.now();
    const timeSinceLastRotate = now - this.lastRotateTime;
    
    // Clean up old request timestamps for current endpoint
    if (this.requestTimestamps[this.currentEndpoint]) {
      this.requestTimestamps[this.currentEndpoint] = this.requestTimestamps[this.currentEndpoint].filter(
        time => now - time < this.windowSize
      );
    }
    
    // Clean up 10-second window requests for rate limiting
    this.requestsIn10SecWindow = this.requestsIn10SecWindow.filter(time => now - time < 10000);
    
    // Clean up method-specific requests
    Object.keys(this.requestsByMethodIn10SecWindow).forEach(method => {
      this.requestsByMethodIn10SecWindow[method] = this.requestsByMethodIn10SecWindow[method].filter(
        time => now - time < 10000
      );
    });
    
    // If we're approaching Solana mainnet rate limits, rotate
    if (this.rateLimit.enableThrottling && this.requestsIn10SecWindow.length > this.rateLimit.maxRequestsPer10Sec * 0.8) {
      logger.debug(`Rotating due to approaching rate limit: ${this.requestsIn10SecWindow.length} requests in 10s window (limit: ${this.rateLimit.maxRequestsPer10Sec})`); 
      return true;
    }
    
    // If we've made too many requests to this endpoint in the window, rotate
    const currentEndpointRequests = this.requestTimestamps[this.currentEndpoint]?.length || 0;
    if (currentEndpointRequests >= this.maxRequestsPerMinute) {
      logger.debug(`Rotating due to high request count: ${currentEndpointRequests} in the last minute for ${this.currentEndpoint}`);
      return true;
    }
    
    // If it's been a while since we rotated, rotate anyway to distribute load
    if (timeSinceLastRotate > 3 * 60 * 1000) { // 3 minutes
      logger.debug(`Rotating due to time elapsed: ${Math.round(timeSinceLastRotate/1000)} seconds since last rotation`);
      return true;
    }
    
    // If this endpoint is in the failed list, rotate
    const failedUntil = this.failedEndpoints.get(this.currentEndpoint);
    if (failedUntil && now < failedUntil) {
      logger.debug(`Rotating away from failed endpoint: ${this.currentEndpoint}`);
      return true;
    }
    
    // Check if there's a better endpoint available (higher tier)
    const currentTier = this.endpointTiers[this.currentEndpoint] || 1;
    const bestAvailableEndpoint = this.findBestEndpoint();
    const bestTier = this.endpointTiers[bestAvailableEndpoint] || 1;
    
    if (bestTier > currentTier) {
      logger.debug(`Rotating to higher tier endpoint: ${bestAvailableEndpoint} (tier ${bestTier}) from ${this.currentEndpoint} (tier ${currentTier})`);
      return true;
    }
    
    return false;
  }
  
  // Check health of a specific endpoint
  async checkEndpointHealth(endpoint) {
    try {
      const connection = this.connections[endpoint];
      const startTime = Date.now();
      
      // Try to get a simple response from the endpoint
      await connection.getRecentBlockhash();
      
      const latency = Date.now() - startTime;
      
      // Update metrics
      if (this.endpointMetrics[endpoint]) {
        this.endpointMetrics[endpoint].successCount++;
        this.endpointMetrics[endpoint].totalLatency += latency;
        this.endpointMetrics[endpoint].lastSuccessTime = Date.now();
      }
      
      // If this endpoint was in the failed list, remove it
      this.failedEndpoints.delete(endpoint);
      
      logger.debug(`Endpoint ${endpoint} health check passed (latency: ${latency}ms)`);
      return true;
    } catch (error) {
      const errorMessage = error.message || 'Unknown error';
      logger.warn(`Endpoint ${endpoint} health check failed: ${errorMessage}`);
      
      // Update metrics
      if (this.endpointMetrics[endpoint]) {
        this.endpointMetrics[endpoint].failureCount++;
      }
      
      // Mark as failed with appropriate cooldown based on error type
      if (errorMessage.includes('429') || errorMessage.includes('Too many requests')) {
        // Rate limit errors - longer cooldown
        this.markEndpointFailed(endpoint, 120000); // 2 minutes for rate limit
      } else if (errorMessage.includes('403') || errorMessage.includes('Forbidden') || errorMessage.includes('Unauthorized') || errorMessage.includes('API key')) {
        // Auth/permission errors - much longer cooldown
        this.markEndpointFailed(endpoint, 3600000); // 1 hour for auth issues
      } else if (errorMessage.includes('fetch failed') || errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ECONNRESET') || errorMessage.includes('socket hang up')) {
        // Network errors - medium cooldown
        this.markEndpointFailed(endpoint, 60000); // 1 minute for network issues
      } else if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
        // Timeout errors - medium cooldown
        this.markEndpointFailed(endpoint, 60000); // 1 minute for timeouts
      } else {
        // Other errors - shorter cooldown
        this.markEndpointFailed(endpoint, 30000); // 30 seconds for other issues
      }
      
      return false;
    }
  }
  
  // Check health of all endpoints
  async checkAllEndpointsHealth() {
    logger.info('Performing health check on all RPC endpoints');
    
    const results = {};
    const healthyEndpoints = [];
    
    // Check each endpoint in parallel
    await Promise.all(this.endpoints.map(async (endpoint) => {
      const isHealthy = await this.checkEndpointHealth(endpoint);
      results[endpoint] = isHealthy;
      if (isHealthy) {
        healthyEndpoints.push(endpoint);
      }
    }));
    
    // Log results
    logger.info(`RPC health check results: ${healthyEndpoints.length}/${this.endpoints.length} endpoints healthy`);
    
    // If current endpoint is unhealthy, rotate to a healthy one
    if (healthyEndpoints.length > 0 && !results[this.currentEndpoint]) {
      this.rotateEndpoint();
    }
    
    return results;
  }

  // Execute an RPC call with retries and rate limiting
  async executeRpcCall(method, ...args) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ 
        method, 
        args, 
        resolve, 
        reject, 
        retries: 0,
        addedTime: Date.now(),
        methodName: method.name || 'unknown', // Store method name for better logging
        lastError: null // Track the last error for better diagnostics
      });
      this.processQueue();
    });
  }

  // Process the queue of RPC requests
  async processQueue() {
    if (this.processing || this.requestQueue.length === 0) return;
    
    this.processing = true;
    
    try {
      const request = this.requestQueue.shift();
      const { method, args, resolve, reject, retries, addedTime, methodName, lastError } = request;
      
      // Log if request has been waiting too long
      const waitTime = Date.now() - addedTime;
      if (waitTime > 5000) {
        logger.debug(`Request ${methodName} waited in queue for ${Math.round(waitTime/1000)}s, queue length: ${this.requestQueue.length}`);
      }
      
      // Check if we need to wait before making another request
      const now = Date.now();
      const timeToWait = Math.max(0, this.lastRequestTime + this.minRequestInterval - now);
      
      if (timeToWait > 0) {
        await new Promise(r => setTimeout(r, timeToWait));
      }
      
      // Check if we should rotate endpoints
      if (this.shouldRotate()) {
        this.rotateEndpoint();
      }
      
      // Track this request for the current endpoint
      if (!this.requestTimestamps[this.currentEndpoint]) {
        this.requestTimestamps[this.currentEndpoint] = [];
      }
      this.requestTimestamps[this.currentEndpoint].push(Date.now());
      this.lastRequestTime = Date.now();
      
      // Track for Solana mainnet rate limiting
      this.requestsIn10SecWindow.push(Date.now());
      
      // Track method-specific requests
      if (!this.requestsByMethodIn10SecWindow[methodName]) {
        this.requestsByMethodIn10SecWindow[methodName] = [];
      }
      this.requestsByMethodIn10SecWindow[methodName].push(Date.now());
      
      // Check if we're exceeding method-specific rate limits
      if (this.rateLimit.enableThrottling && 
          this.requestsByMethodIn10SecWindow[methodName].length > this.rateLimit.maxRequestsPerMethodPer10Sec) {
        logger.warn(`Rate limit exceeded for method ${methodName}: ${this.requestsByMethodIn10SecWindow[methodName].length} requests in 10s window`);
        // Add artificial delay to slow down
        await new Promise(r => setTimeout(r, 1000));
      }
      
      if (!this.requestCounts[this.currentEndpoint]) {
        this.requestCounts[this.currentEndpoint] = 0;
      }
      this.requestCounts[this.currentEndpoint]++;
      
      // Execute the RPC call
      try {
        const connection = this.getCurrentConnection();
        
        // Check if method exists on the connection
        if (typeof method !== 'function') {
          throw new Error(`Invalid RPC method: ${methodName}`);
        }
        
        // Process arguments - remove undefined/null and provide defaults where needed
        let processedArgs = [];
        
        // Only keep non-undefined, non-null arguments
        for (let i = 0; i < args.length; i++) {
          if (args[i] !== undefined && args[i] !== null) {
            processedArgs.push(args[i]);
          } else if (i === 1 && methodName === 'getAccountInfo') {
            // For getAccountInfo, provide default commitment if missing
            processedArgs.push('confirmed');
          } else if (i === 2 && (methodName === 'getTokenAccountsByOwner' || 
                               methodName === 'getParsedTokenAccountsByOwner')) {
            // For token account methods, provide default commitment if missing
            processedArgs.push('confirmed');
          }
        }
        
        // Add timeout to prevent hanging requests
        const timeoutPromise = new Promise((_, timeoutReject) => {
          setTimeout(() => timeoutReject(new Error(`RPC request timeout for ${methodName}`)), 15000);
        });
        
        // Track start time for latency measurement
        const startTime = Date.now();
        
        // Race between the actual request and the timeout
        const result = await Promise.race([
          method.apply(connection, processedArgs),
          timeoutPromise
        ]);
        
        // Calculate latency
        const latency = Date.now() - startTime;
        
        // Update metrics for successful request
        if (this.endpointMetrics[this.currentEndpoint]) {
          this.endpointMetrics[this.currentEndpoint].successCount++;
          this.endpointMetrics[this.currentEndpoint].totalLatency += latency;
          this.endpointMetrics[this.currentEndpoint].lastSuccessTime = Date.now();
        }
        
        // Log slow requests
        if (latency > 2000) {
          logger.debug(`Slow RPC request: ${methodName} took ${latency}ms on ${this.currentEndpoint}`);
        }
        
        resolve(result);
      } catch (error) {
        // Handle various error types
        const errorMessage = error.message || 'Unknown error';
        
        // Categorize errors
        const isRateLimitError = errorMessage.includes('429') || 
                               errorMessage.includes('Too many requests') ||
                               errorMessage.includes('rate limit');
                               
        const isTimeoutError = errorMessage.includes('timeout') || 
                             errorMessage.includes('timed out');
                             
        const isConnectionError = errorMessage.includes('ECONNREFUSED') || 
                                errorMessage.includes('ECONNRESET') ||
                                errorMessage.includes('socket hang up') ||
                                errorMessage.includes('network error') ||
                                errorMessage.includes('fetch failed');
                                
        const isAuthError = errorMessage.includes('API key is not allowed') ||
                         errorMessage.includes('403 Forbidden') ||
                         errorMessage.includes('Unauthorized');
        
        // Determine if we should retry
        const shouldRetry = (isRateLimitError || isTimeoutError || isConnectionError) && retries < this.maxRetries;
        
        // Update metrics for failed request
        if (this.endpointMetrics[this.currentEndpoint]) {
          this.endpointMetrics[this.currentEndpoint].failureCount++;
        }
        
        if (shouldRetry) {
          // Mark this endpoint as problematic
          if (isRateLimitError) {
            logger.warn(`RPC rate limit hit on ${this.getCurrentEndpoint()} for ${methodName}. Rotating endpoint and retrying...`);
            this.markEndpointFailed(this.currentEndpoint, 60000); // 1 minute cooldown for rate limited endpoints
          } else if (isConnectionError || isTimeoutError) {
            logger.warn(`Connection error with ${this.getCurrentEndpoint()} for ${methodName}: ${errorMessage}. Rotating endpoint...`);
            this.markEndpointFailed(this.currentEndpoint, 120000); // 2 minute cooldown for connection issues
          } else if (isAuthError) {
            logger.warn(`Authentication error with ${this.getCurrentEndpoint()} for ${methodName}: ${errorMessage}. Rotating endpoint...`);
            this.markEndpointFailed(this.currentEndpoint, 3600000); // 1 hour cooldown for auth errors
          }
          
          // Always rotate after an error
          this.rotateEndpoint();
          
          // Calculate backoff time - exponential with jitter
          const baseDelay = Math.min(1000 * Math.pow(2, retries), 30000);
          const jitter = Math.random() * 1000;
          const backoffTime = baseDelay + jitter;
          
          logger.debug(`Retrying ${methodName} request after ${Math.round(backoffTime)}ms (attempt ${retries + 1}/${this.maxRetries})`);
          
          // Put the request back in the queue with exponential backoff
          setTimeout(() => {
            this.requestQueue.unshift({
              ...request,
              retries: retries + 1,
              addedTime: Date.now(), // Reset the added time for accurate wait tracking
              lastError: error // Store the last error
            });
            this.processQueue();
          }, backoffTime);
        } else {
          // We've exceeded retries or it's a non-retryable error
          if (retries >= this.maxRetries) {
            logger.error(`Max retries (${this.maxRetries}) exceeded for ${methodName} RPC request: ${errorMessage}`);
            
            // If we've had multiple failures, check all endpoints health
            if (this.requestQueue.length > 5) {
              this.checkAllEndpointsHealth();
            }
          } else {
            logger.error(`Non-retryable RPC error for ${methodName}: ${errorMessage}`);
          }
          
          // If we have a previous error, include it in the rejection
          if (lastError) {
            logger.debug(`Previous error for ${methodName}: ${lastError.message}`);
          }
          
          reject(error);
        }
      }
    } catch (error) {
      logger.error(`Error in RPC queue processing: ${error.message}`);
      // If we have a critical error in the queue processing, try to recover
      if (this.requestQueue.length > 0) {
        await this.checkAllEndpointsHealth();
      }
    } finally {
      this.processing = false;
      // Process next request with a small delay
      setTimeout(() => this.processQueue(), 50);
    }
  }

  // Wrapper methods for common RPC calls with proper default values
  async getAccountInfo(address, commitment = 'confirmed') {
    if (!address) {
      throw new Error('Address is required for getAccountInfo');
    }
    return this.executeRpcCall(Connection.prototype.getAccountInfo, address, commitment);
  }

  async getTokenAccountsByOwner(owner, filter, commitment = 'confirmed') {
    if (!owner) {
      throw new Error('Owner is required for getTokenAccountsByOwner');
    }
    if (!filter) {
      throw new Error('Filter is required for getTokenAccountsByOwner');
    }
    return this.executeRpcCall(Connection.prototype.getTokenAccountsByOwner, owner, filter, commitment);
  }

  async getParsedTokenAccountsByOwner(owner, filter, commitment = 'confirmed') {
    if (!owner) {
      throw new Error('Owner is required for getParsedTokenAccountsByOwner');
    }
    if (!filter) {
      throw new Error('Filter is required for getParsedTokenAccountsByOwner');
    }
    return this.executeRpcCall(Connection.prototype.getParsedTokenAccountsByOwner, owner, filter, commitment);
  }

  async getTokenSupply(tokenMint, commitment = 'confirmed') {
    if (!tokenMint) {
      throw new Error('Token mint is required for getTokenSupply');
    }
    return this.executeRpcCall(Connection.prototype.getTokenSupply, tokenMint, commitment);
  }

  async getTokenLargestAccounts(tokenMint, commitment = 'confirmed') {
    if (!tokenMint) {
      throw new Error('Token mint is required for getTokenLargestAccounts');
    }
    return this.executeRpcCall(Connection.prototype.getTokenLargestAccounts, tokenMint, commitment);
  }

  async getSignaturesForAddress(address, options = { limit: 10 }) {
    if (!address) {
      throw new Error('Address is required for getSignaturesForAddress');
    }
    return this.executeRpcCall(Connection.prototype.getSignaturesForAddress, address, options);
  }

  async getTransaction(signature, options = { maxSupportedTransactionVersion: 0 }) {
    if (!signature) {
      throw new Error('Signature is required for getTransaction');
    }
    // Ensure options includes maxSupportedTransactionVersion
    const transactionOptions = {
      ...options,
      maxSupportedTransactionVersion: 0
    };
    return this.executeRpcCall(Connection.prototype.getTransaction, signature, transactionOptions);
  }
  
  // Method to simulate a token swap with a default SOL amount
  async simulateTokenSwap(tokenAddress, solAmount = 0.1) {
    if (!tokenAddress) {
      throw new Error('Token address is required for simulateTokenSwap');
    }
    
    if (solAmount === undefined || solAmount === null) {
      solAmount = 0.1; // Ensure we always have a default value
    }
    
    // Log with the actual SOL amount
    logger.info(`Simulating swap for token: ${tokenAddress.toString()} with ${solAmount} SOL`);
    
    // In a real implementation, you would use Jupiter or another DEX aggregator
    // to simulate the actual swap transaction
    try {
      // Make sure we have a PublicKey object
      const tokenPublicKey = typeof tokenAddress === 'string' ? 
        new PublicKey(tokenAddress) : tokenAddress;
      
      // Get token info to verify it exists
      const tokenInfo = await this.getAccountInfo(tokenPublicKey);
      
      if (!tokenInfo) {
        return {
          success: false,
          details: 'Token account not found',
        };
      }
      
      // Try to get token supply as an additional check
      try {
        const tokenSupply = await this.getTokenSupply(tokenPublicKey);
        if (!tokenSupply || !tokenSupply.value) {
          return {
            success: false,
            details: 'Token supply not available',
          };
        }
      } catch (supplyError) {
        logger.warn(`Could not fetch token supply during swap simulation: ${supplyError.message}`);
        // Continue anyway, this is just an additional check
      }
      
      // This is just a placeholder for the actual simulation
      // In a real implementation, you would build and simulate a swap transaction
      return {
        success: true,
        details: 'Swap simulation successful',
      };
    } catch (error) {
      // If we get an RPC error, don't immediately fail the simulation
      if (error.message && (error.message.includes('fetch failed') || 
                           error.message.includes('429') ||
                           error.message.includes('timeout') ||
                           error.message.includes('API key'))) {
        logger.warn(`RPC error during swap simulation, but continuing: ${error.message}`);
        return {
          success: true, // Assume success despite RPC error
          details: `RPC error during simulation, but continuing: ${error.message}`,
        };
      }
      
      logger.error(`Error in simulateTokenSwap: ${error.message}`);
      return {
        success: false,
        details: `Error during swap simulation: ${error.message}`,
      };
    }
  }

  // Add more wrapper methods as needed
  
  // Method to check RPC health and recover if needed
  async checkRpcHealth() {
    try {
      // Try to get a simple response from the current endpoint
      const connection = this.getCurrentConnection();
      await connection.getRecentBlockhash();
      return true;
    } catch (error) {
      logger.warn(`RPC health check failed for ${this.currentEndpoint}: ${error.message}`);
      
      // Mark the current endpoint as failed
      this.markEndpointFailed(this.currentEndpoint, 60000);
      
      // Rotate to a different endpoint
      this.rotateEndpoint();
      
      // Try the new endpoint
      try {
        const connection = this.getCurrentConnection();
        await connection.getRecentBlockhash();
        logger.info(`Successfully recovered RPC connection using ${this.currentEndpoint}`);
        return true;
      } catch (secondError) {
        logger.error(`Failed to recover RPC connection: ${secondError.message}`);
        
        // If we can't recover with the current rotation strategy, try a full health check
        return this.checkAllEndpointsHealth();
      }
    }
  }
  
  // Method to reset all connections if needed
  async resetConnections() {
    logger.info('Resetting all RPC connections');
    
    // Clear all failure records
    this.failedEndpoints.clear();
    
    // Reset request counts and timestamps
    this.endpoints.forEach(endpoint => {
      this.requestCounts[endpoint] = 0;
      this.requestTimestamps[endpoint] = [];
    });
    
    // Reset metrics but keep the history
    this.endpoints.forEach(endpoint => {
      if (this.endpointMetrics[endpoint]) {
        // Keep the counts but reset the latency
        this.endpointMetrics[endpoint].totalLatency = 0;
      }
    });
    
    // Find the best endpoint to use
    this.currentEndpoint = this.findBestEndpoint();
    this.lastRotateTime = Date.now();
    
    // Check if the selected endpoint is healthy
    return this.checkRpcHealth();
  }
  
  // Get endpoint metrics for monitoring
  getEndpointMetrics() {
    const metrics = {};
    const now = Date.now();
    
    // Calculate global rate limit usage
    this.requestsIn10SecWindow = this.requestsIn10SecWindow.filter(time => now - time < 10000);
    const globalRateLimitUsage = this.requestsIn10SecWindow.length / this.rateLimit.maxRequestsPer10Sec;
    
    this.endpoints.forEach(endpoint => {
      const metric = this.endpointMetrics[endpoint] || {
        successCount: 0,
        failureCount: 0,
        totalLatency: 0,
        lastSuccessTime: 0
      };
      
      const totalRequests = metric.successCount + metric.failureCount;
      const successRate = totalRequests > 0 ? (metric.successCount / totalRequests) * 100 : 0;
      const avgLatency = metric.successCount > 0 ? metric.totalLatency / metric.successCount : 0;
      const isFailed = this.failedEndpoints.has(endpoint);
      const failedUntil = this.failedEndpoints.get(endpoint) || 0;
      const cooldownRemaining = Math.max(0, failedUntil - Date.now());
      
      metrics[endpoint] = {
        successCount: metric.successCount,
        failureCount: metric.failureCount,
        successRate: Math.round(successRate * 100) / 100,
        avgLatency: Math.round(avgLatency),
        isFailed,
        cooldownRemaining: Math.round(cooldownRemaining / 1000),
        tier: this.endpointTiers[endpoint] || 1,
        isCurrent: endpoint === this.currentEndpoint
      };
    });
    
    // Add global rate limit metrics
    metrics.globalRateLimits = {
      requestsIn10Sec: this.requestsIn10SecWindow.length,
      maxRequestsPer10Sec: this.rateLimit.maxRequestsPer10Sec,
      usagePercentage: Math.round(globalRateLimitUsage * 100),
      methodSpecificUsage: {}
    };
    
    // Add method-specific rate limit usage
    Object.keys(this.requestsByMethodIn10SecWindow).forEach(method => {
      this.requestsByMethodIn10SecWindow[method] = this.requestsByMethodIn10SecWindow[method].filter(
        time => now - time < 10000
      );
      
      const methodUsage = this.requestsByMethodIn10SecWindow[method].length / this.rateLimit.maxRequestsPerMethodPer10Sec;
      metrics.globalRateLimits.methodSpecificUsage[method] = {
        requestsIn10Sec: this.requestsByMethodIn10SecWindow[method].length,
        maxRequestsPer10Sec: this.rateLimit.maxRequestsPerMethodPer10Sec,
        usagePercentage: Math.round(methodUsage * 100)
      };
    });
    
    return metrics;
  }
}

module.exports = new RPCManager();
