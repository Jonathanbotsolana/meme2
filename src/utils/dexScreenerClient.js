/**
 * DexScreener API client for checking active trading pairs
 * Enhanced with robust error handling, retries, and fallbacks
 */
const axios = require('axios');
const logger = require('./logger');

class DexScreenerClient {
  constructor() {
    this.baseUrl = 'https://api.dexscreener.com/latest';
    this.cacheTimeout = 10 * 60 * 1000; // 10 minutes cache (increased from 5)
    this.pairCache = new Map();
    
    // Request configuration
    this.requestConfig = {
      timeout: 30000, // 30 second timeout
      maxRetries: 3,
      retryDelay: 2000, // 2 seconds
      maxConcurrentRequests: 2
    };
    
    // Track active requests
    this.activeRequests = 0;
    this.requestQueue = [];
    this.processing = false;
    this.lastRequestTime = 0;
    this.minRequestInterval = 1500; // 1.5 seconds between requests
    
    // Fallback data for emergency situations
    this.emergencyFallbackData = new Map();
  }
  
  /**
   * Make a rate-limited request to DexScreener API with retries
   * @param {string} endpoint - API endpoint
   * @param {Object} params - Request parameters
   * @returns {Promise<Object>} - API response
   */
  async makeRequest(endpoint, params = {}) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ endpoint, params, resolve, reject });
      this.processQueue();
    });
  }
  
  /**
   * Process the request queue with rate limiting
   */
  async processQueue() {
    if (this.processing || this.requestQueue.length === 0 || this.activeRequests >= this.requestConfig.maxConcurrentRequests) {
      return;
    }
    
    this.processing = true;
    
    try {
      const { endpoint, params, resolve, reject } = this.requestQueue.shift();
      
      // Apply rate limiting
      const now = Date.now();
      const timeToWait = Math.max(0, this.lastRequestTime + this.minRequestInterval - now);
      
      if (timeToWait > 0) {
        await new Promise(r => setTimeout(r, timeToWait));
      }
      
      this.activeRequests++;
      this.lastRequestTime = Date.now();
      
      try {
        // Make the request with retries
        const response = await this.makeRequestWithRetries(endpoint, params);
        resolve(response);
      } catch (error) {
        logger.error(`DexScreener API request failed after retries: ${error.message}`);
        reject(error);
      } finally {
        this.activeRequests--;
      }
    } catch (error) {
      logger.error(`Error processing DexScreener request queue: ${error.message}`);
    } finally {
      this.processing = false;
      
      // Continue processing the queue
      setTimeout(() => this.processQueue(), 50);
    }
  }
  
  /**
   * Make a request with automatic retries
   * @param {string} endpoint - API endpoint
   * @param {Object} params - Request parameters
   * @returns {Promise<Object>} - API response
   */
  async makeRequestWithRetries(endpoint, params = {}) {
    let retries = 0;
    let lastError = null;
    
    while (retries <= this.requestConfig.maxRetries) {
      try {
        const url = `${this.baseUrl}${endpoint}`;
        logger.debug(`Making request to DexScreener API: ${url}`);
        
        const response = await axios({
          url,
          method: 'GET',
          params,
          timeout: this.requestConfig.timeout,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'KairosMemeBot/1.0'
          }
        });
        
        return response.data;
      } catch (error) {
        lastError = error;
        
        // Check if we should retry
        const shouldRetry = this.shouldRetryRequest(error, retries);
        
        if (shouldRetry) {
          retries++;
          const delay = this.requestConfig.retryDelay * Math.pow(2, retries - 1); // Exponential backoff
          logger.warn(`DexScreener API request failed, retrying in ${delay}ms (${retries}/${this.requestConfig.maxRetries}): ${error.message}`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw error;
        }
      }
    }
    
    throw lastError;
  }
  
  /**
   * Determine if a request should be retried
   * @param {Error} error - The error that occurred
   * @param {number} retries - Current retry count
   * @returns {boolean} - Whether to retry the request
   */
  shouldRetryRequest(error, retries) {
    // Don't retry if we've reached the max retries
    if (retries >= this.requestConfig.maxRetries) {
      return false;
    }
    
    // Retry on network errors
    if (!error.response) {
      return true;
    }
    
    // Retry on rate limiting or server errors
    const status = error.response.status;
    return status === 429 || status === 503 || status === 502 || status === 500;
  }

  /**
   * Check if a token has active trading pairs on any DEX
   * @param {string} tokenAddress - The token address to check
   * @param {Object} options - Options for the check
   * @param {boolean} options.requireVerifiedPair - Whether to require at least one verified pair
   * @param {number} options.minLiquidityUsd - Minimum liquidity in USD
   * @param {number} options.minVolumeUsd - Minimum 24h volume in USD
   * @param {Array<string>} options.preferredDexes - List of preferred DEXes to prioritize
   * @returns {Promise<{hasActivePairs: boolean, pairs: Array, bestPair: Object|null, jupiterCompatiblePairs: Array}>}
   */
  async checkActivePairs(tokenAddress, options = {}) {
    try {
      const {
        requireVerifiedPair = false,
        minLiquidityUsd = 1000, // Default $1000 min liquidity
        minVolumeUsd = 100, // Default $100 min 24h volume
        preferredDexes = ['raydium', 'orca', 'meteora', 'jupiter', 'pumpswap', 'phoenix', 'dooar']
      } = options;

      // Check cache first
      const cacheKey = `${tokenAddress}-${requireVerifiedPair}-${minLiquidityUsd}-${minVolumeUsd}-${preferredDexes.join(',')}`;
      const cachedResult = this.pairCache.get(cacheKey);
      if (cachedResult && cachedResult.timestamp > Date.now() - this.cacheTimeout) {
        logger.debug(`Using cached DexScreener result for ${tokenAddress}`);
        return cachedResult.data;
      }
      
      // Store the token address in emergency fallback data if we don't have it yet
      if (!this.emergencyFallbackData.has(tokenAddress)) {
        // Create a minimal fallback result
        this.emergencyFallbackData.set(tokenAddress, {
          hasActivePairs: false,
          pairs: [],
          bestPair: null,
          jupiterCompatiblePairs: [],
          preferredPairs: [],
          hasJupiterCompatiblePairs: false,
          hasPreferredPairs: false,
          isEmergencyFallback: true
        });
      }

      // Fetch pairs from DexScreener
      logger.info(`Checking DexScreener for active pairs for token: ${tokenAddress}`);
      
      let response;
      try {
        response = await this.makeRequest(`/dex/tokens/${tokenAddress}`);
      } catch (error) {
        logger.error(`Error fetching pairs from DexScreener for ${tokenAddress}: ${error.message}`);
        
        // Use cached data even if expired as a fallback
        if (cachedResult) {
          logger.warn(`Using expired cached data for ${tokenAddress} due to API error`);
          return cachedResult.data;
        }
        
        // Use emergency fallback data if available
        if (this.emergencyFallbackData.has(tokenAddress)) {
          logger.warn(`Using emergency fallback data for ${tokenAddress}`);
          return this.emergencyFallbackData.get(tokenAddress);
        }
        
        // Return empty result if no fallback available
        const emptyResult = {
          hasActivePairs: false,
          pairs: [],
          bestPair: null,
          jupiterCompatiblePairs: [],
          preferredPairs: [],
          hasJupiterCompatiblePairs: false,
          hasPreferredPairs: false,
          error: error.message
        };
        
        return emptyResult;
      }

      if (!response || !response.pairs || !Array.isArray(response.pairs)) {
        logger.warn(`No pairs found on DexScreener for token: ${tokenAddress}`);
        const result = {
          hasActivePairs: false,
          pairs: [],
          bestPair: null,
          jupiterCompatiblePairs: [],
          preferredPairs: [],
          hasJupiterCompatiblePairs: false,
          hasPreferredPairs: false
        };
        this.pairCache.set(cacheKey, { timestamp: Date.now(), data: result });
        return result;
      }

      // Filter pairs based on criteria
      const validPairs = response.pairs.filter(pair => {
        // Check liquidity
        const liquidity = parseFloat(pair.liquidity?.usd || 0);
        if (liquidity < minLiquidityUsd) return false;

        // Check volume
        const volume = parseFloat(pair.volume?.h24 || 0);
        if (volume < minVolumeUsd) return false;

        // Check if verified pair is required
        if (requireVerifiedPair && !pair.verified) return false;

        return true;
      });

      // Identify Jupiter-compatible pairs
      // Jupiter supports these DEXes: Raydium, Orca, Meteora, Jupiter Swap, etc.
      const jupiterCompatibleDexes = [
        'raydium', 'orca', 'meteora', 'jupiter', 'openbook', 'serum',
        'cykura', 'saros', 'saber', 'mercurial', 'aldrin', 'crema',
        'lifinity', 'dexlab', 'step', 'cropper', 'goosefx', 'dradex'
      ];

      // Verify Jupiter compatibility with stricter checks
      const jupiterCompatiblePairs = validPairs.filter(pair => {
        const dexId = pair.dexId?.toLowerCase();

        // Check if the DEX is in our Jupiter-compatible list
        const isCompatibleDex = jupiterCompatibleDexes.includes(dexId);

        // Additional verification: check liquidity thresholds for specific DEXes
        if (isCompatibleDex) {
          const liquidity = parseFloat(pair.liquidity?.usd || 0);

          // Higher liquidity requirements for less established DEXes
          if (dexId === 'dexlab' || dexId === 'step' || dexId === 'cropper') {
            return liquidity >= 5000; // $5,000 minimum for these DEXes
          }

          // For major DEXes like Raydium, Orca, etc., use the standard threshold
          return true;
        }

        return false;
      });

      // Identify preferred pairs based on user configuration
      const preferredPairs = validPairs.filter(pair => {
        const dexId = pair.dexId?.toLowerCase();
        return preferredDexes.map(d => d.toLowerCase()).includes(dexId);
      });

      // Sort pairs by priority: preferred DEXes first, then by liquidity
      validPairs.sort((a, b) => {
        const aIsPreferred = preferredDexes.map(d => d.toLowerCase()).includes(a.dexId?.toLowerCase());
        const bIsPreferred = preferredDexes.map(d => d.toLowerCase()).includes(b.dexId?.toLowerCase());

        if (aIsPreferred && !bIsPreferred) return -1;
        if (!aIsPreferred && bIsPreferred) return 1;

        // If both are preferred or both are not preferred, sort by liquidity
        const liquidityA = parseFloat(a.liquidity?.usd || 0);
        const liquidityB = parseFloat(b.liquidity?.usd || 0);
        return liquidityB - liquidityA;
      });

      const result = {
        hasActivePairs: validPairs.length > 0,
        pairs: validPairs,
        bestPair: validPairs.length > 0 ? validPairs[0] : null,
        jupiterCompatiblePairs,
        preferredPairs,
        hasJupiterCompatiblePairs: jupiterCompatiblePairs.length > 0,
        hasPreferredPairs: preferredPairs.length > 0
      };

      // Cache the result
      this.pairCache.set(cacheKey, { timestamp: Date.now(), data: result });
      
      // Update emergency fallback data
      this.emergencyFallbackData.set(tokenAddress, result);

      if (result.hasActivePairs) {
        logger.info(`Found ${validPairs.length} active trading pairs for ${tokenAddress} on DexScreener`);
        logger.info(`Jupiter-compatible pairs: ${jupiterCompatiblePairs.length}, Preferred pairs: ${preferredPairs.length}`);

        if (result.bestPair) {
          logger.info(`Best pair: ${result.bestPair.dexId} - ${result.bestPair.pairAddress} with ${result.bestPair.liquidity?.usd} liquidity`);
        }
      } else {
        logger.warn(`No active trading pairs found for ${tokenAddress} on DexScreener`);
      }

      return result;
    } catch (error) {
      logger.error(`Error checking DexScreener for token ${tokenAddress}: ${error.message}`);
      
      // Use emergency fallback data if available
      if (this.emergencyFallbackData.has(tokenAddress)) {
        logger.warn(`Using emergency fallback data for ${tokenAddress} due to error`);
        return this.emergencyFallbackData.get(tokenAddress);
      }
      
      return {
        hasActivePairs: false,
        pairs: [],
        bestPair: null,
        jupiterCompatiblePairs: [],
        preferredPairs: [],
        hasJupiterCompatiblePairs: false,
        hasPreferredPairs: false,
        error: error.message
      };
    }
  }

  /**
   * Get DEX information for a specific token to help with routing
   * @param {string} tokenAddress - The token address to check
   * @returns {Promise<{dexes: Array<string>, bestDex: string|null, pairAddresses: Object}>}
   */
  async getTokenDexInfo(tokenAddress) {
    try {
      // Check cache first
      const cacheKey = `dex-info-${tokenAddress}`;
      const cachedResult = this.pairCache.get(cacheKey);
      if (cachedResult && cachedResult.timestamp > Date.now() - this.cacheTimeout) {
        logger.debug(`Using cached DexScreener DEX info for ${tokenAddress}`);
        return cachedResult.data;
      }

      // Get pairs information - reuse our existing method which has caching and fallbacks
      const pairsInfo = await this.checkActivePairs(tokenAddress, {
        minLiquidityUsd: 500, // Lower threshold to get more DEXes
        minVolumeUsd: 50     // Lower threshold to get more DEXes
      });

      if (!pairsInfo.hasActivePairs) {
        logger.warn(`No active DEXes found for token: ${tokenAddress}`);
        const emptyResult = {
          dexes: [],
          bestDex: null,
          pairAddresses: {},
          jupiterCompatibleDexes: [],
          hasJupiterCompatibleDexes: false
        };
        
        // Cache the empty result
        this.pairCache.set(cacheKey, { timestamp: Date.now(), data: emptyResult });
        return emptyResult;
      }

      // Extract unique DEX IDs
      const dexes = [...new Set(pairsInfo.pairs.map(pair => pair.dexId))];
      
      // Extract Jupiter-compatible DEXes
      const jupiterCompatibleDexes = [...new Set(pairsInfo.jupiterCompatiblePairs.map(pair => pair.dexId))];

      // Get best DEX (highest liquidity)
      const bestDex = pairsInfo.bestPair ? pairsInfo.bestPair.dexId : null;

      // Create mapping of DEX to pair addresses
      const pairAddresses = {};
      pairsInfo.pairs.forEach(pair => {
        if (!pairAddresses[pair.dexId]) {
          pairAddresses[pair.dexId] = [];
        }
        pairAddresses[pair.dexId].push({
          pairAddress: pair.pairAddress,
          liquidity: pair.liquidity?.usd || 0,
          volume24h: pair.volume?.h24 || 0,
          baseToken: pair.baseToken?.address,
          quoteToken: pair.quoteToken?.address
        });
      });

      const result = {
        dexes,
        bestDex,
        pairAddresses,
        jupiterCompatibleDexes,
        hasJupiterCompatibleDexes: jupiterCompatibleDexes.length > 0
      };

      // Cache the result
      this.pairCache.set(cacheKey, { timestamp: Date.now(), data: result });

      logger.info(`Found ${dexes.length} DEXes for token ${tokenAddress}, ${jupiterCompatibleDexes.length} Jupiter-compatible`);
      if (bestDex) {
        logger.info(`Best DEX for token ${tokenAddress}: ${bestDex}`);
      }

      return result;
    } catch (error) {
      logger.error(`Error getting DEX info from DexScreener for ${tokenAddress}: ${error.message}`);
      
      // Try to use cached data even if expired
      const cacheKey = `dex-info-${tokenAddress}`;
      const cachedResult = this.pairCache.get(cacheKey);
      if (cachedResult) {
        logger.warn(`Using expired cached DEX info for ${tokenAddress} due to error`);
        return cachedResult.data;
      }
      
      return {
        dexes: [],
        bestDex: null,
        pairAddresses: {},
        jupiterCompatibleDexes: [],
        hasJupiterCompatibleDexes: false,
        error: error.message
      };
    }
  }

  /**
   * Get detailed information about a specific token
   * @param {string} tokenAddress - The token address to check
   * @returns {Promise<Object>} - Token information
   */
  async getTokenInfo(tokenAddress) {
    try {
      // Check cache first
      const cacheKey = `token-info-${tokenAddress}`;
      const cachedResult = this.pairCache.get(cacheKey);
      if (cachedResult && cachedResult.timestamp > Date.now() - this.cacheTimeout) {
        logger.debug(`Using cached DexScreener token info for ${tokenAddress}`);
        return cachedResult.data;
      }

      logger.info(`Getting token info from DexScreener for: ${tokenAddress}`);
      
      let response;
      try {
        response = await this.makeRequest(`/dex/tokens/${tokenAddress}`);
      } catch (error) {
        logger.error(`Error fetching token info from DexScreener for ${tokenAddress}: ${error.message}`);
        
        // Use cached data even if expired as a fallback
        if (cachedResult) {
          logger.warn(`Using expired cached token info for ${tokenAddress} due to API error`);
          return cachedResult.data;
        }
        
        // Return null if no fallback available
        return null;
      }

      if (!response || !response.pairs || !Array.isArray(response.pairs) || response.pairs.length === 0) {
        logger.warn(`No token info found on DexScreener for: ${tokenAddress}`);
        return null;
      }

      // Extract token info from the first pair
      const firstPair = response.pairs[0];
      const isBaseToken = firstPair.baseToken.address.toLowerCase() === tokenAddress.toLowerCase();
      
      const tokenInfo = isBaseToken ? firstPair.baseToken : firstPair.quoteToken;
      
      // Add additional metrics from pairs
      const allPairs = response.pairs;
      const totalLiquidityUsd = allPairs.reduce((sum, pair) => sum + parseFloat(pair.liquidity?.usd || 0), 0);
      const totalVolume24h = allPairs.reduce((sum, pair) => sum + parseFloat(pair.volume?.h24 || 0), 0);
      
      const result = {
        ...tokenInfo,
        totalPairs: allPairs.length,
        totalLiquidityUsd,
        totalVolume24h,
        priceUsd: tokenInfo.priceUsd,
        priceChange24h: tokenInfo.priceChange24h,
        pairs: allPairs.map(pair => ({
          dexId: pair.dexId,
          pairAddress: pair.pairAddress,
          liquidity: pair.liquidity,
          volume24h: pair.volume?.h24,
          priceUsd: isBaseToken ? pair.priceUsd : (1 / parseFloat(pair.priceUsd)),
          verified: pair.verified
        }))
      };

      // Cache the result
      this.pairCache.set(cacheKey, { timestamp: Date.now(), data: result });

      return result;
    } catch (error) {
      logger.error(`Error getting token info from DexScreener for ${tokenAddress}: ${error.message}`);
      
      // Try to use cached data even if expired
      const cacheKey = `token-info-${tokenAddress}`;
      const cachedResult = this.pairCache.get(cacheKey);
      if (cachedResult) {
        logger.warn(`Using expired cached token info for ${tokenAddress} due to error`);
        return cachedResult.data;
      }
      
      return null;
    }
  }

  /**
   * Clear the cache for a specific token or all tokens
   * @param {string} [tokenAddress] - Optional token address to clear cache for
   */
  clearCache(tokenAddress = null) {
    if (tokenAddress) {
      // Clear cache for specific token
      for (const key of this.pairCache.keys()) {
        if (key.includes(tokenAddress)) {
          this.pairCache.delete(key);
        }
      }
      
      // Clear emergency fallback data for this token
      if (this.emergencyFallbackData.has(tokenAddress)) {
        this.emergencyFallbackData.delete(tokenAddress);
      }
      
      logger.debug(`Cleared DexScreener cache for token: ${tokenAddress}`);
    } else {
      // Clear all cache
      this.pairCache.clear();
      this.emergencyFallbackData.clear();
      logger.debug('Cleared all DexScreener cache');
    }
  }
  /**
   * Clean up expired cache entries to prevent memory leaks
   * This should be called periodically
   */
  cleanupExpiredCache() {
    try {
      const now = Date.now();
      let expiredCount = 0;
      
      // Clean up main cache
      for (const [key, value] of this.pairCache.entries()) {
        if (value.timestamp < now - (this.cacheTimeout * 2)) { // Double the cache timeout for cleanup
          this.pairCache.delete(key);
          expiredCount++;
        }
      }
      
      if (expiredCount > 0) {
        logger.debug(`Cleaned up ${expiredCount} expired DexScreener cache entries`);
      }
      
      // Limit emergency fallback data size
      if (this.emergencyFallbackData.size > 1000) { // Arbitrary limit
        logger.warn(`Emergency fallback data size (${this.emergencyFallbackData.size}) exceeds limit, clearing oldest entries`);
        
        // Convert to array, sort by timestamp, and keep only the newest 500
        const entries = Array.from(this.emergencyFallbackData.entries());
        this.emergencyFallbackData.clear();
        
        // Keep the newest 500 entries
        entries.slice(-500).forEach(([key, value]) => {
          this.emergencyFallbackData.set(key, value);
        });
        
        logger.info(`Reduced emergency fallback data size to ${this.emergencyFallbackData.size} entries`);
      }
    } catch (error) {
      logger.error(`Error cleaning up expired cache: ${error.message}`);
    }
  }
}

// Create a singleton instance
const dexScreenerClient = new DexScreenerClient();

// Set up periodic cache cleanup
setInterval(() => {
  dexScreenerClient.cleanupExpiredCache();
}, 30 * 60 * 1000); // Run every 30 minutes

module.exports = dexScreenerClient;