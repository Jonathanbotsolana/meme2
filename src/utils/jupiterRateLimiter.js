/**
 * Jupiter API Rate Limiter
 * 
 * This module provides rate limiting for Jupiter API calls based on different tiers.
 * It implements token bucket algorithm for rate limiting with separate buckets for
 * regular API calls and Price API calls.
 */
const logger = require('./logger');

class JupiterRateLimiter {
  /**
   * Create a new Jupiter rate limiter
   * @param {Object} options - Configuration options
   * @param {string} options.tier - API tier ('free', 'proI', 'proII', 'proIII', 'proIV')
   * @param {string} options.apiKey - Jupiter API key (required for paid tiers)
   * @param {number} options.maxConcurrentRequests - Maximum concurrent requests
   * @param {number} options.maxRetries - Maximum number of retries for failed requests
   * @param {boolean} options.debug - Enable debug logging
   */
  constructor(options = {}) {
    // Default configuration
    this.config = {
      tier: options.tier || 'free',
      apiKey: options.apiKey || null,
      maxConcurrentRequests: options.maxConcurrentRequests || 2,
      maxRetries: options.maxRetries || 3,
      debug: options.debug || false,
      platformFeeBps: options.platformFeeBps || 0,
      feeAccount: options.feeAccount || null
    };
    
    // Validate tier and API key
    if (this.config.tier !== 'free' && !this.config.apiKey) {
      throw new Error('API key is required for paid tiers');
    }
    
    // Set up tier configuration
    this.setTier(this.config.tier, this.config.apiKey);
    
    // Request tracking
    this.activeRequests = 0;
    this.requestQueue = [];
    this.processing = false;
    
    // Statistics
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      retries: 0,
      rateLimit429Errors: 0,
      otherErrors: 0,
      lastRequestTime: 0
    };
    
    this.log(`Initialized Jupiter Rate Limiter with ${this.config.tier} tier`);
  }
  
  /**
   * Log a message if debug is enabled
   * @param {string} message - The message to log
   */
  log(message) {
    if (this.config.debug) {
      logger.debug(`[JupiterRateLimiter] ${message}`);
    }
  }
  
  /**
   * Get the current status of the rate limiter
   * @returns {Object} - Current status
   */
  getStatus() {
    // Calculate tokens available
    this.refillTokens();
    
    return {
      tier: this.config.tier,
      apiKey: this.config.apiKey ? '****' + this.config.apiKey.slice(-4) : null,
      hostname: this.tierConfig.hostname,
      requestsPerMinute: this.tierConfig.requestsPerMinute,
      tokensAvailable: {
        default: Math.floor(this.defaultBucket.tokens),
        price: this.tierConfig.hasSeparatePriceBucket ? Math.floor(this.priceBucket.tokens) : Math.floor(this.defaultBucket.tokens)
      },
      activeRequests: this.activeRequests,
      queuedRequests: this.requestQueue.length,
      platformFeeBps: this.config.platformFeeBps,
      feeAccount: this.config.feeAccount ? (this.config.feeAccount.slice(0, 4) + '...' + this.config.feeAccount.slice(-4)) : null,
      stats: this.stats,
      lastRequestTime: this.stats.lastRequestTime ? new Date(this.stats.lastRequestTime).toISOString() : null
    };
  }
  
  /**
   * Get the API hostname based on current tier
   * @returns {string} - API hostname
   */
  getApiHostname() {
    return `https://${this.tierConfig.hostname}`;
  }
  
  /**
   * Check if the API key is valid
   * @returns {Promise<boolean>} - Whether the API key is valid
   */
  async checkApiKey() {
    if (!this.config.apiKey) {
      return false;
    }
    
    try {
      const response = await fetch(`${this.getApiHostname()}/v6/quote-status`, {
        headers: {
          'Jupiter-API-Key': this.config.apiKey
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        this.log(`API key check successful: ${JSON.stringify(data)}`);
        return true;
      } else {
        const errorText = await response.text();
        this.log(`API key check failed: ${response.status} ${errorText}`);
        return false;
      }
    } catch (error) {
      this.log(`API key check error: ${error.message}`);
      return false;
    }
  }
  
  /**
   * Refill tokens in the buckets based on elapsed time
   */
  refillTokens() {
    const now = Date.now();
    
    // Refill default bucket
    const timeElapsedDefault = Math.max(0, now - this.defaultBucket.lastRefill);
    const tokensToAddDefault = (timeElapsedDefault / 1000) * this.defaultBucket.refillRate;
    
    this.defaultBucket.tokens = Math.min(
      this.tierConfig.tokensAllocated,
      this.defaultBucket.tokens + tokensToAddDefault
    );
    this.defaultBucket.lastRefill = now;
    
    // Refill price bucket if separate
    if (this.tierConfig.hasSeparatePriceBucket) {
      const timeElapsedPrice = Math.max(0, now - this.priceBucket.lastRefill);
      const tokensToAddPrice = (timeElapsedPrice / 1000) * this.priceBucket.refillRate;
      
      this.priceBucket.tokens = Math.min(
        this.tierConfig.tokensAllocated,
        this.priceBucket.tokens + tokensToAddPrice
      );
      this.priceBucket.lastRefill = now;
    }
  }
  
  /**
   * Check if tokens are available in the specified bucket
   * @param {boolean} isPriceApi - Whether this is a Price API call
   * @returns {boolean} - Whether tokens are available
   */
  hasTokens(isPriceApi = false) {
    this.refillTokens();
    
    const bucket = isPriceApi && this.tierConfig.hasSeparatePriceBucket ? 
      this.priceBucket : this.defaultBucket;
    
    return bucket.tokens >= 1;
  }
  
  /**
   * Consume a token from the appropriate bucket
   * @param {boolean} isPriceApi - Whether this is a Price API call
   * @returns {boolean} - Whether a token was successfully consumed
   */
  consumeToken(isPriceApi = false) {
    if (!this.hasTokens(isPriceApi)) {
      return false;
    }
    
    const bucket = isPriceApi && this.tierConfig.hasSeparatePriceBucket ? 
      this.priceBucket : this.defaultBucket;
    
    bucket.tokens -= 1;
    return true;
  }
  
  /**
   * Execute a function with rate limiting
   * @param {Function} fn - The function to execute
   * @param {boolean} isPriceApi - Whether this is a Price API call
   * @returns {Promise<any>} - The result of the function
   */
  async execute(fn, isPriceApi = false) {
    return new Promise((resolve, reject) => {
      // Add to queue
      this.requestQueue.push({
        fn,
        isPriceApi,
        resolve,
        reject,
        retries: 0,
        addedTime: Date.now()
      });
      
      // Process queue
      this.processQueue();
    });
  }
  
  /**
   * Process the request queue
   */
  async processQueue() {
    if (this.processing || this.requestQueue.length === 0) {
      return;
    }
    
    this.processing = true;
    
    try {
      // Check if we can process more requests
      if (this.activeRequests >= this.config.maxConcurrentRequests) {
        this.log(`Max concurrent requests reached (${this.activeRequests}/${this.config.maxConcurrentRequests}), waiting...`);
        this.processing = false;
        return;
      }
      
      // Get next request
      const request = this.requestQueue.shift();
      const { fn, isPriceApi, resolve, reject, retries, addedTime } = request;
      
      // Check if we have tokens available
      if (!this.hasTokens(isPriceApi)) {
        const waitTime = this.getWaitTimeForToken(isPriceApi);
        this.log(`Rate limit reached, waiting ${waitTime}ms before retrying`);
        
        // Put back in queue and wait
        this.requestQueue.unshift(request);
        setTimeout(() => this.processQueue(), waitTime);
        this.processing = false;
        return;
      }
      
      // Consume token
      this.consumeToken(isPriceApi);
      
      // Track request
      this.activeRequests++;
      this.stats.totalRequests++;
      
      // Log wait time if significant
      const waitTime = Date.now() - addedTime;
      if (waitTime > 1000) {
        this.log(`Request waited in queue for ${waitTime}ms`);
      }
      
      try {
        // Execute the function
        this.stats.lastRequestTime = Date.now();
        const result = await fn();
        
        // Success
        this.stats.successfulRequests++;
        resolve(result);
      } catch (error) {
        // Handle rate limit errors
        const isRateLimitError = error.message && (
          error.message.includes('429') || 
          error.message.includes('Too many requests') ||
          error.message.includes('rate limit') ||
          error.message.includes('Rate limit exceeded') ||
          error.message.includes('too many requests') ||
          error.message.includes('quota exceeded') ||
          (error.status && error.status === 429) ||
          (error.statusCode && error.statusCode === 429)
        );
        
        // Handle network errors that should be retried
        const isNetworkError = error.message && (
          error.message.includes('ECONNRESET') ||
          error.message.includes('ETIMEDOUT') ||
          error.message.includes('ECONNREFUSED') ||
          error.message.includes('socket hang up') ||
          error.message.includes('network error') ||
          error.message.includes('Failed to fetch') ||
          error.message.includes('timeout') ||
          error.message.includes('connection error')
        );
        
        if (isRateLimitError) {
          this.stats.rateLimit429Errors++;
          
          // Log the rate limit error
          logger.warn(`Rate limit error encountered: ${error.message}`);
          
          // Retry with backoff if under max retries
          if (retries < this.config.maxRetries) {
            // Exponential backoff with jitter
            const backoffTime = Math.pow(2, retries) * 1000 + Math.random() * 1000;
            this.log(`Rate limit hit, retrying in ${backoffTime}ms (attempt ${retries + 1}/${this.config.maxRetries})`);
            
            this.stats.retries++;
            
            // Put back in queue with backoff
            setTimeout(() => {
              this.requestQueue.unshift({
                ...request,
                retries: retries + 1,
                addedTime: Date.now()
              });
              this.processQueue();
            }, backoffTime);
          } else {
            // Max retries exceeded
            this.log(`Max retries exceeded for rate limited request`);
            this.stats.failedRequests++;
            reject(error);
          }
        } else if (isNetworkError) {
          this.stats.otherErrors++;
          
          // Log the network error
          logger.warn(`Network error encountered: ${error.message}`);
          
          // Retry with backoff if under max retries
          if (retries < this.config.maxRetries) {
            // Linear backoff with jitter for network errors
            const backoffTime = 1000 * (retries + 1) + Math.random() * 500;
            this.log(`Network error, retrying in ${backoffTime}ms (attempt ${retries + 1}/${this.config.maxRetries})`);
            
            this.stats.retries++;
            
            // Put back in queue with backoff
            setTimeout(() => {
              this.requestQueue.unshift({
                ...request,
                retries: retries + 1,
                addedTime: Date.now()
              });
              this.processQueue();
            }, backoffTime);
          } else {
            // Max retries exceeded
            this.log(`Max retries exceeded for network error`);
            this.stats.failedRequests++;
            reject(error);
          }
        } else {
          // Other errors
          this.stats.otherErrors++;
          this.stats.failedRequests++;
          reject(error);
        }
      } finally {
        // Decrement active requests
        this.activeRequests--;
      }
    } catch (error) {
      this.log(`Error in queue processing: ${error.message}`);
    } finally {
      this.processing = false;
      
      // Continue processing queue
      setImmediate(() => this.processQueue());
    }
  }
  
  /**
   * Calculate wait time until a token is available
   * @param {boolean} isPriceApi - Whether this is a Price API call
   * @returns {number} - Wait time in milliseconds
   */
  getWaitTimeForToken(isPriceApi = false) {
    const bucket = isPriceApi && this.tierConfig.hasSeparatePriceBucket ? 
      this.priceBucket : this.defaultBucket;
    
    // If we have tokens, no need to wait
    if (bucket.tokens >= 1) {
      return 0;
    }
    
    // Calculate time until next token
    const tokensNeeded = 1 - bucket.tokens;
    const timeToWait = (tokensNeeded / bucket.refillRate) * 1000; // Convert to milliseconds
    
    // Add a small buffer
    return Math.ceil(timeToWait + 50);
  }
  
  /**
   * Set or update the tier configuration
   * @param {string} tier - The tier to set ('free', 'proI', 'proII', 'proIII', 'proIV')
   * @param {string} apiKey - The API key for paid tiers
   * @returns {Object} - Current status after update
   */
  setTier(tier, apiKey = null) {
    // Validate tier and API key
    if (tier !== 'free' && !apiKey) {
      throw new Error('API key is required for paid tiers');
    }
    
    // Define tier configurations
    const tierConfigs = {
      free: {
        requestsPerMinute: 60,
        tokensAllocated: 10,
        refillPeriodMs: 10000, // 10 seconds
        hasSeparatePriceBucket: false,
        hostname: 'lite-api.jup.ag' // Free tier uses lite-api.jup.ag
      },
      proI: {
        requestsPerMinute: 600,
        tokensAllocated: 100,
        refillPeriodMs: 10000, // 10 seconds
        hasSeparatePriceBucket: true,
        hostname: 'lite-api.jup.ag' // All tiers now use lite-api.jup.ag
      },
      proII: {
        requestsPerMinute: 3000,
        tokensAllocated: 500,
        refillPeriodMs: 10000, // 10 seconds
        hasSeparatePriceBucket: true,
        hostname: 'lite-api.jup.ag'
      },
      proIII: {
        requestsPerMinute: 6000,
        tokensAllocated: 1000,
        refillPeriodMs: 10000, // 10 seconds
        hasSeparatePriceBucket: true,
        hostname: 'lite-api.jup.ag'
      },
      proIV: {
        requestsPerMinute: 30000,
        tokensAllocated: 5000,
        refillPeriodMs: 10000, // 10 seconds
        hasSeparatePriceBucket: true,
        hostname: 'lite-api.jup.ag'
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
      refillRate: this.tierConfig.requestsPerMinute / 60 // Tokens per second
    };
    
    // Separate bucket for Price API if the tier supports it
    this.priceBucket = this.tierConfig.hasSeparatePriceBucket ? {
      tokens: this.tierConfig.tokensAllocated,
      lastRefill: Date.now(),
      refillRate: this.tierConfig.requestsPerMinute / 60 // Tokens per second
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
 *   debug: true,
 *   platformFeeBps: 10, // 0.1% platform fee (optional)
 *   feeAccount: 'YOUR_FEE_ACCOUNT_ADDRESS' // Required if platformFeeBps > 0
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