/**
 * Jupiter API Rate Limiter
 * 
 * This utility helps manage rate limits for Jupiter API calls by implementing:
 * - Adaptive backoff strategy
 * - Request queuing
 * - Exponential backoff with jitter
 * - Rate limit detection and handling
 * - Tier-based rate limiting (Free, Pro I, Pro II, Pro III, Pro IV)
 * - Separate buckets for Price API and other APIs
 */

class JupiterRateLimiter {
  constructor(options = {}) {
    // Define tier configurations
    const tierConfigs = {
      free: {
        requestsPerMinute: 60,
        tokensAllocated: 60,
        refillPeriodMs: 60000, // 1 minute
        hasSeparatePriceBucket: false,
        hostname: 'lite-api.jup.ag' // Free tier uses lite-api.jup.ag
      },
      proI: {
        requestsPerMinute: 600,
        tokensAllocated: 100,
        refillPeriodMs: 10000, // 10 seconds
        hasSeparatePriceBucket: true,
        hostname: 'api.jup.ag' // Paid tiers use api.jup.ag
      },
      proII: {
        requestsPerMinute: 3000,
        tokensAllocated: 500,
        refillPeriodMs: 10000, // 10 seconds
        hasSeparatePriceBucket: true,
        hostname: 'api.jup.ag'
      },
      proIII: {
        requestsPerMinute: 6000,
        tokensAllocated: 1000,
        refillPeriodMs: 10000, // 10 seconds
        hasSeparatePriceBucket: true,
        hostname: 'api.jup.ag'
      },
      proIV: {
        requestsPerMinute: 30000,
        tokensAllocated: 5000,
        refillPeriodMs: 10000, // 10 seconds
        hasSeparatePriceBucket: true,
        hostname: 'api.jup.ag'
      }
    };

    this.config = {
      maxConcurrentRequests: options.maxConcurrentRequests || 2,
      baseBackoff: options.baseBackoff || 1000, // 1 second
      maxBackoff: options.maxBackoff || 30000, // 30 seconds
      backoffMultiplier: options.backoffMultiplier || 2,
      maxRetries: options.maxRetries || 10,
      debug: options.debug || false,
      tier: options.tier || 'free', // Default to free tier
      apiKey: options.apiKey || null,
      ...options
    };

    // Set tier configuration
    this.tierConfig = tierConfigs[this.config.tier] || tierConfigs.free;
    
    // Token bucket implementation
    this.defaultBucket = {
      tokens: this.tierConfig.tokensAllocated,
      lastRefill: Date.now(),
      refillRate: this.tierConfig.tokensAllocated / this.tierConfig.refillPeriodMs
    };
    
    // Separate bucket for Price API if the tier supports it
    this.priceBucket = this.tierConfig.hasSeparatePriceBucket ? {
      tokens: this.tierConfig.tokensAllocated,
      lastRefill: Date.now(),
      refillRate: this.tierConfig.tokensAllocated / this.tierConfig.refillPeriodMs
    } : this.defaultBucket; // For free tier, use the same bucket

    // State tracking
    this.activeRequests = 0;
    this.requestQueue = [];
    this.consecutiveRateLimits = 0;
    this.lastRateLimitTime = 0;
    this.currentBackoff = this.config.baseBackoff;
    this.isRateLimited = false;
    this.rateLimitResetTime = 0;
    
    this.log(`Initialized Jupiter Rate Limiter with ${this.config.tier} tier`);
    this.log(`Rate limit: ${this.tierConfig.requestsPerMinute} requests per minute`);
    this.log(`API hostname: ${this.tierConfig.hostname}`);
  }

  /**
   * Logs debug messages if debug is enabled
   */
  log(...args) {
    if (this.config.debug) {
      console.log('[JupiterRateLimiter]', ...args);
    }
  }

  /**
   * Get the API hostname based on tier
   */
  getApiHostname() {
    return this.tierConfig.hostname;
  }

  /**
   * Refills tokens in a bucket based on elapsed time
   * @private
   */
  _refillBucket(bucket) {
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefill;
    
    if (elapsedMs > 0) {
      // Calculate tokens to add based on elapsed time and refill rate
      const tokensToAdd = elapsedMs * bucket.refillRate;
      
      // Add tokens up to the maximum allocation
      bucket.tokens = Math.min(bucket.tokens + tokensToAdd, this.tierConfig.tokensAllocated);
      bucket.lastRefill = now;
      
      this.log(`Refilled bucket with ${tokensToAdd.toFixed(2)} tokens. Now has ${bucket.tokens.toFixed(2)} tokens`);
    }
    
    return bucket.tokens;
  }

  /**
   * Consumes a token from the appropriate bucket if available
   * @private
   */
  _consumeToken(isPriceApi) {
    // If we're in a rate limited state, check if we can exit it
    if (this.isRateLimited && Date.now() >= this.rateLimitResetTime) {
      this.log('Rate limit period has expired, resetting state');
      this.isRateLimited = false;
      this.consecutiveRateLimits = 0;
      this.currentBackoff = this.config.baseBackoff;
    }
    
    // If we're still rate limited, don't consume a token
    if (this.isRateLimited) {
      return false;
    }
    
    // Determine which bucket to use
    const bucket = isPriceApi ? this.priceBucket : this.defaultBucket;
    
    // Refill the bucket based on elapsed time
    this._refillBucket(bucket);
    
    // Check if we have tokens available
    if (bucket.tokens >= 1) {
      // Consume a token
      bucket.tokens -= 1;
      this.log(`Consumed token from ${isPriceApi ? 'price' : 'default'} bucket. Remaining: ${bucket.tokens.toFixed(2)}`);
      return true;
    }
    
    this.log(`No tokens available in ${isPriceApi ? 'price' : 'default'} bucket`);
    return false;
  }

  /**
   * Internal method to execute a function with retries
   * @private
   */
  async _executeWithRetries(fn, isPriceApi, args) {
    this.activeRequests++;
    let retries = 0;

    try {
      while (retries <= this.config.maxRetries) {
        try {
          const result = await fn(...args);
          
          // Success - reset backoff and consecutive rate limits
          this.consecutiveRateLimits = 0;
          this.currentBackoff = this.config.baseBackoff;
          
          // Process next queued request if any
          this._processNextQueuedRequest();
          
          return result;
        } catch (error) {
          const isRateLimit = this._isRateLimitError(error);
          
          if (isRateLimit) {
            this.consecutiveRateLimits++;
            this.lastRateLimitTime = Date.now();
            
            // Calculate backoff with exponential increase and jitter
            const backoff = Math.min(
              this.currentBackoff * Math.pow(this.config.backoffMultiplier, this.consecutiveRateLimits - 1),
              this.config.maxBackoff
            );
            
            // Add jitter (±20%)
            const jitter = backoff * 0.2 * (Math.random() * 2 - 1);
            const finalBackoff = Math.max(backoff + jitter, 500); // At least 500ms
            
            // If we've hit multiple rate limits in succession, implement a longer cooldown
            if (this.consecutiveRateLimits >= 3) {
              this.isRateLimited = true;
              
              // Calculate reset time based on tier configuration
              // For more severe rate limiting, we'll wait longer than the standard refill period
              const cooldownMultiplier = Math.min(this.consecutiveRateLimits, 10); // Cap at 10x
              this.rateLimitResetTime = Date.now() + (this.tierConfig.refillPeriodMs * cooldownMultiplier);
              
              console.warn(`Jupiter API rate limit hit ${this.consecutiveRateLimits} times in succession. ` +
                          `Cooling down for ${(this.rateLimitResetTime - Date.now()) / 1000}s ` +
                          `(${isPriceApi ? 'Price API' : 'Default'} bucket)`);
              
              // Reset the affected bucket
              const bucket = isPriceApi ? this.priceBucket : this.defaultBucket;
              bucket.tokens = 0;
              bucket.lastRefill = this.rateLimitResetTime - this.tierConfig.refillPeriodMs;
            }
            
            retries++;
            if (retries <= this.config.maxRetries) {
              console.warn(`Jupiter API rate limited. Retrying in ${Math.round(finalBackoff)}ms (${retries}/${this.config.maxRetries})`);
              await new Promise(resolve => setTimeout(resolve, finalBackoff));
            } else {
              throw new Error(`Jupiter API rate limit exceeded after ${retries} retries: ${error.message}`);
            }
          } else {
            // Not a rate limit error, just throw it
            throw error;
          }
        }
      }
    } finally {
      this.activeRequests--;
    }
  }

  /**
   * Process the next request in the queue
   * @private
   */
  _processNextQueuedRequest() {
    if (this.requestQueue.length > 0 && this.activeRequests < this.config.maxConcurrentRequests) {
      const { fn, isPriceApi, args, resolve, reject } = this.requestQueue.shift();
      this.log(`Processing queued request, remaining queue: ${this.requestQueue.length}`);
      
      // Check if we have tokens available in the appropriate bucket
      if (this._consumeToken(isPriceApi)) {
        this._executeWithRetries(fn, isPriceApi, args)
          .then(resolve)
          .catch(reject);
      } else {
        // No tokens available, put the request back at the front of the queue
        this.requestQueue.unshift({ fn, isPriceApi, args, resolve, reject });
        
        // Calculate time until next token is available
        const bucket = isPriceApi ? this.priceBucket : this.defaultBucket;
        const timeUntilNextToken = (1 / bucket.refillRate) * 1000; // ms until next token
        
        this.log(`No tokens available for queued request. Waiting ${timeUntilNextToken}ms before trying again`);
        
        // Try again after waiting for token refill
        setTimeout(() => this._processNextQueuedRequest(), timeUntilNextToken);
      }
    }
  }

  /**
   * Determines if an error is a rate limit error
   * @private
   */
  _isRateLimitError(error) {
    const errorMessage = error.message || String(error);
    return (
      errorMessage.includes('429') ||
      errorMessage.includes('Too Many Requests') ||
      errorMessage.includes('rate limit') ||
      errorMessage.includes('too many requests') ||
      errorMessage.includes('RATE_LIMIT')
    );
  }

  /**
   * Executes a function with rate limiting
   * @param {Function} fn - The function to execute
   * @param {boolean} isPriceApi - Whether this is a Price API call (uses separate bucket)
   * @param {Array} args - Arguments to pass to the function
   * @returns {Promise<any>} - The result of the function
   */
  async execute(fn, isPriceApi = false, ...args) {
    // If we're at max concurrent requests, queue this request
    if (this.activeRequests >= this.config.maxConcurrentRequests) {
      this.log(`Max concurrent requests reached (${this.activeRequests}/${this.config.maxConcurrentRequests}). Queueing request.`);
      
      return new Promise((resolve, reject) => {
        this.requestQueue.push({ fn, isPriceApi, args, resolve, reject });
      });
    }
    
    // Check if we have tokens available
    if (this._consumeToken(isPriceApi)) {
      return this._executeWithRetries(fn, isPriceApi, args);
    } else {
      // No tokens available, queue the request
      this.log(`No tokens available. Queueing request.`);
      
      return new Promise((resolve, reject) => {
        this.requestQueue.push({ fn, isPriceApi, args, resolve, reject });
        
        // If this is the first queued request, start processing the queue
        if (this.requestQueue.length === 1) {
          // Calculate time until next token is available
          const bucket = isPriceApi ? this.priceBucket : this.defaultBucket;
          const timeUntilNextToken = (1 / bucket.refillRate) * 1000; // ms until next token
          
          setTimeout(() => this._processNextQueuedRequest(), timeUntilNextToken);
        }
      });
    }
  }

  /**
   * Gets the current rate limiter status
   */
  getStatus() {
    // Refill buckets before reporting status
    this._refillBucket(this.defaultBucket);
    if (this.tierConfig.hasSeparatePriceBucket) {
      this._refillBucket(this.priceBucket);
    }
    
    return {
      tier: this.config.tier,
      hostname: this.tierConfig.hostname,
      requestsPerMinute: this.tierConfig.requestsPerMinute,
      defaultBucket: {
        tokens: Math.floor(this.defaultBucket.tokens * 100) / 100, // Round to 2 decimal places
        maxTokens: this.tierConfig.tokensAllocated,
        refillPeriod: this.tierConfig.refillPeriodMs / 1000 + 's',
        percentFull: Math.floor((this.defaultBucket.tokens / this.tierConfig.tokensAllocated) * 100) + '%'
      },
      priceBucket: this.tierConfig.hasSeparatePriceBucket ? {
        tokens: Math.floor(this.priceBucket.tokens * 100) / 100, // Round to 2 decimal places
        maxTokens: this.tierConfig.tokensAllocated,
        refillPeriod: this.tierConfig.refillPeriodMs / 1000 + 's',
        percentFull: Math.floor((this.priceBucket.tokens / this.tierConfig.tokensAllocated) * 100) + '%'
      } : 'Using default bucket',
      activeRequests: this.activeRequests,
      queuedRequests: this.requestQueue.length,
      isRateLimited: this.isRateLimited,
      rateLimitResetIn: this.isRateLimited ? Math.max(0, this.rateLimitResetTime - Date.now()) : 0,
      consecutiveRateLimits: this.consecutiveRateLimits,
      currentBackoff: this.currentBackoff
    };
  }

  /**
   * Clears the rate limit state and resets buckets
   */
  clearRateLimit() {
    this.isRateLimited = false;
    this.consecutiveRateLimits = 0;
    this.currentBackoff = this.config.baseBackoff;
    
    // Reset buckets to full
    this.defaultBucket.tokens = this.tierConfig.tokensAllocated;
    this.defaultBucket.lastRefill = Date.now();
    
    if (this.tierConfig.hasSeparatePriceBucket) {
      this.priceBucket.tokens = this.tierConfig.tokensAllocated;
      this.priceBucket.lastRefill = Date.now();
    }
    
    this.log('Rate limit state cleared and buckets refilled');
  }
  
  /**
   * Updates the tier configuration
   * @param {string} tier - The new tier ('free', 'proI', 'proII', 'proIII', 'proIV')
   * @param {string} apiKey - The API key for the tier
   */
  updateTier(tier, apiKey = null) {
    // Define tier configurations
    const tierConfigs = {
      free: {
        requestsPerMinute: 60,
        tokensAllocated: 60,
        refillPeriodMs: 60000, // 1 minute
        hasSeparatePriceBucket: false,
        hostname: 'lite-api.jup.ag' // Free tier uses lite-api.jup.ag
      },
      proI: {
        requestsPerMinute: 600,
        tokensAllocated: 100,
        refillPeriodMs: 10000, // 10 seconds
        hasSeparatePriceBucket: true,
        hostname: 'api.jup.ag' // Paid tiers use api.jup.ag
      },
      proII: {
        requestsPerMinute: 3000,
        tokensAllocated: 500,
        refillPeriodMs: 10000, // 10 seconds
        hasSeparatePriceBucket: true,
        hostname: 'api.jup.ag'
      },
      proIII: {
        requestsPerMinute: 6000,
        tokensAllocated: 1000,
        refillPeriodMs: 10000, // 10 seconds
        hasSeparatePriceBucket: true,
        hostname: 'api.jup.ag' // Paid tiers use api.jup.ag
      },
      proIV: {
        requestsPerMinute: 30000,
        tokensAllocated: 5000,
        refillPeriodMs: 10000, // 10 seconds
        hasSeparatePriceBucket: true,
        hostname: 'api.jup.ag' // Paid tiers use api.jup.ag
      }
    };
    
    if (!tierConfigs[tier]) {
      throw new Error(`Invalid tier: ${tier}. Must be one of: ${Object.keys(tierConfigs).join(', ')}`);
    }
    
    // Update config
    this.config.tier = tier;
    this.config.apiKey = apiKey;
    
    // Update tier configuration
    this.tierConfig = tierConfigs[tier];
    
    // Reset buckets with new configuration
    this.defaultBucket = {
      tokens: this.tierConfig.tokensAllocated,
      lastRefill: Date.now(),
      refillRate: this.tierConfig.tokensAllocated / this.tierConfig.refillPeriodMs
    };
    
    // Separate bucket for Price API if the tier supports it
    this.priceBucket = this.tierConfig.hasSeparatePriceBucket ? {
      tokens: this.tierConfig.tokensAllocated,
      lastRefill: Date.now(),
      refillRate: this.tierConfig.tokensAllocated / this.tierConfig.refillPeriodMs
    } : this.defaultBucket; // For free tier, use the same bucket
    
    this.log(`Updated to ${tier} tier with ${this.tierConfig.requestsPerMinute} requests per minute`);
    this.log(`API hostname: ${this.tierConfig.hostname}`);
    
    return this.getStatus();
  }
}

module.exports = JupiterRateLimiter;

/**
 * Example usage:
 *
 * const JupiterRateLimiter = require('./jupiter-rate-limiter');
 * const { Jupiter } = require('@jup-ag/core');
 *
 * // Create rate limiter with tier configuration
 * const rateLimiter = new JupiterRateLimiter({
 *   tier: 'proII', // 'free', 'proI', 'proII', 'proIII', 'proIV'
 *   apiKey: 'YOUR_JUPITER_API_KEY', // Required for paid tiers
 *   maxConcurrentRequests: 2,
 *   maxRetries: 10,
 *   debug: true
 * });
 *
 * // Example usage for regular API calls
 * async function example() {
 *   // Initialize Jupiter with rate limiting
 *   const jupiter = await rateLimiter.execute(async () => {
 *     return await Jupiter.load({
 *       connection,
 *       cluster: 'mainnet-beta',
 *       apiKey: rateLimiter.config.apiKey // Pass the API key from rate limiter
 *     });
 *   });
 *   
 *   // Get routes with rate limiting (not a price API call)
 *   const routes = await rateLimiter.execute(async () => {
 *     return await jupiter.computeRoutes({
 *       inputMint,
 *       outputMint,
 *       amount: amountInLamports,
 *       slippageBps: 100,
 *     });
 *   });
 *   
 *   // For Price API calls, specify isPriceApi = true
 *   const price = await rateLimiter.execute(
 *     async () => {
 *       return await fetch(`${rateLimiter.getApiHostname()}/v4/price?ids=SOL`);
 *     },
 *     true // This is a Price API call
 *   );
 * }
 *
 * // Example function to get Jupiter quote
 * async function getJupiterQuote(inputMint, outputMint, amount) {
 *   // Wrap the Jupiter API call with the rate limiter
 *   return rateLimiter.execute(async () => {
 *     // Your Jupiter API call here
 *     const quote = await jupiter.computeRoutes({
 *       inputMint,
 *       outputMint,
 *       amount,
 *       slippageBps: 50
 *     });
 *     return quote;
 *   });
 * }
 *
 * // Usage
 * async function swapTokens() {
 *   try {
 *     const quote = await getJupiterQuote(inputMint, outputMint, amount);
 *     console.log('Got quote:', quote);
 *     
 *     // Execute swap
 *     const swapResult = await rateLimiter.execute(async () => {
 *       return await jupiter.exchange({
 *         routeInfo: quote.routesInfos[0]
 *       });
 *     });
 *     
 *     console.log('Swap successful:', swapResult);
 *   } catch (error) {
 *     console.error('Swap failed:', error);
 *   }
 * }
 */