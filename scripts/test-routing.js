/**
 * Test script for verifying Jupiter routing with fallback mechanisms
 * Usage: node scripts/test-routing.js <TOKEN_ADDRESS>
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const { Jupiter } = require('@jup-ag/core');

// Healthy RPC endpoints from health check
const RPC_ENDPOINTS = [
  'https://mainnet.helius-rpc.com/?api-key=f7e0528e-7e2d-404f-8ae7-e774405c422f',
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
  'https://solana-api.projectserum.com',
  'https://solana.api.mngo.cloud',
  'https://hidden-indulgent-card.solana-mainnet.quiknode.pro/88200bf9df13e5a27afeadbd45afa50be60273b9/',
  // TODO: Add premium RPC endpoints with higher rate limits
  // Examples:
  // 'https://your-premium-quicknode-endpoint.com',
  // 'https://solana-mainnet.g.alchemy.com/v2/YOUR_API_KEY',
  // 'https://mainnet.helius-rpc.com/?api-key=YOUR_PREMIUM_API_KEY',
  // Removed failing endpoints:
  // 'https://api.devnet.solana.com', // This is a devnet endpoint, not mainnet
  // 'https://jup.ag/api/rpc', // Failing with 404
  // 'https://jupiter-rpc.publicnode.com', // Failing with 404
  // 'https://mainnet.solana-dapp.com', // Failing with fetch error
  // 'https://rpc.ankr.com/solana', // Failing with 403 Forbidden
  // 'https://solana-mainnet.g.alchemy.com/v2/demo' // Failing with 429 Too Many Requests
];

// Common tokens for routing
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const BONK_MINT = new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
const USDT_MINT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
const WBTC_MINT = new PublicKey('9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E');
const WETH_MINT = new PublicKey('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs');
const JUP_MINT = new PublicKey('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
const RAY_MINT = new PublicKey('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R');
const MEME_MINT = new PublicKey('5bpj3W9zC2Y5Zn2jDBcYVscGnCBUN5RD7152cfL9pump');
const WIF_MINT = new PublicKey('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm');

// Connection manager for RPC failover
class ConnectionManager {
  constructor() {
    this.endpoints = RPC_ENDPOINTS;
    this.currentEndpointIndex = 0;
    this.connection = new Connection(this.endpoints[0], 'confirmed');
    this.failedEndpoints = new Map(); // Track failed endpoints and their retry times
    this.maxRetryDelay = 300000; // 5 minutes max retry delay
    this.baseRetryDelay = 5000; // 5 seconds base retry delay
  }

  getConnection() {
    return this.connection;
  }

  getCurrentEndpoint() {
    return this.endpoints[this.currentEndpointIndex];
  }

  markEndpointAsFailed(endpoint, error) {
    const now = Date.now();
    const existingFailure = this.failedEndpoints.get(endpoint) || { failures: 0, lastFailure: 0 };
    
    // Increment failure count and update last failure time
    existingFailure.failures += 1;
    existingFailure.lastFailure = now;
    existingFailure.error = error.message;
    
    // Calculate exponential backoff with jitter
    const backoff = Math.min(
      this.maxRetryDelay,
      this.baseRetryDelay * Math.pow(2, Math.min(existingFailure.failures - 1, 8))
    );
    const jitter = Math.random() * 0.3 * backoff; // 0-30% jitter
    const retryDelay = backoff + jitter;
    
    existingFailure.retryAfter = now + retryDelay;
    this.failedEndpoints.set(endpoint, existingFailure);
    
    console.log(`Marked endpoint ${endpoint} as failed (retry after ${Math.round(retryDelay/1000)}s): ${error.message}`);
  }

  isEndpointHealthy(endpoint) {
    const failure = this.failedEndpoints.get(endpoint);
    if (!failure) return true;
    
    const now = Date.now();
    if (now >= failure.retryAfter) {
      // Retry time has passed, consider it potentially healthy again
      return true;
    }
    
    return false;
  }

  async findHealthyEndpoint() {
    // Start from the next endpoint after current
    const startIndex = (this.currentEndpointIndex + 1) % this.endpoints.length;
    let index = startIndex;
    
    do {
      const endpoint = this.endpoints[index];
      if (this.isEndpointHealthy(endpoint)) {
        // Found a potentially healthy endpoint
        this.currentEndpointIndex = index;
        this.connection = new Connection(endpoint, 'confirmed');
        
        try {
          // Quick health check
          await this.connection.getRecentBlockhash('finalized');
          console.log(`Switched to healthy RPC endpoint: ${endpoint}`);
          return this.connection;
        } catch (error) {
          // Mark as failed and continue searching
          this.markEndpointAsFailed(endpoint, error);
        }
      }
      
      // Move to next endpoint
      index = (index + 1) % this.endpoints.length;
    } while (index !== startIndex);
    
    // If we've tried all endpoints and none are healthy, use the least recently failed one
    console.log('All endpoints are currently marked as unhealthy, using least recently failed one');
    
    // Find the endpoint with the earliest retry time
    let earliestRetry = Infinity;
    let bestEndpoint = this.endpoints[0];
    
    for (const endpoint of this.endpoints) {
      const failure = this.failedEndpoints.get(endpoint);
      if (!failure || failure.retryAfter < earliestRetry) {
        earliestRetry = failure ? failure.retryAfter : 0;
        bestEndpoint = endpoint;
      }
    }
    
    this.currentEndpointIndex = this.endpoints.indexOf(bestEndpoint);
    this.connection = new Connection(bestEndpoint, 'confirmed');
    console.log(`Using least recently failed endpoint: ${bestEndpoint}`);
    return this.connection;
  }

  async switchEndpoint() {
    try {
      return await this.findHealthyEndpoint();
    } catch (error) {
      console.error(`Error switching endpoints: ${error.message}`);
      // Fallback to simple rotation if something goes wrong
      this.currentEndpointIndex = (this.currentEndpointIndex + 1) % this.endpoints.length;
      const endpoint = this.endpoints[this.currentEndpointIndex];
      console.log(`Falling back to next RPC endpoint: ${endpoint}`);
      this.connection = new Connection(endpoint, 'confirmed');
      return this.connection;
    }
  }
}

// Advanced rate limiter with exponential backoff for 429 responses
class RateLimiter {
  constructor(maxRequests = 1, interval = 2000) {
    this.queue = [];
    this.maxRequests = maxRequests;
    this.interval = interval;
    this.processing = false;
    this.consecutiveErrors = 0;
    this.baseDelay = 2000; // Start with 2 seconds
    this.maxDelay = 30000; // Max 30 seconds
  }

  async execute(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  calculateBackoff() {
    // Exponential backoff with jitter
    const exponentialPart = Math.min(
      this.maxDelay,
      this.baseDelay * Math.pow(2, Math.min(this.consecutiveErrors, 5))
    );
    const jitter = Math.random() * 0.3 * exponentialPart; // 0-30% jitter
    return exponentialPart + jitter;
  }

  async executeWithRetry(fn, maxRetries = 5) {
    let retries = 0;
    
    while (retries <= maxRetries) {
      try {
        const result = await fn();
        // Success - reset consecutive errors
        this.consecutiveErrors = 0;
        return result;
      } catch (error) {
        if (error.message && error.message.includes('429')) {
          // Rate limit error
          this.consecutiveErrors++;
          retries++;
          
          if (retries <= maxRetries) {
            const delay = this.calculateBackoff();
            console.log(`Rate limited. Retrying after ${Math.round(delay/1000)}s delay...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          } else {
            throw new Error(`Rate limit exceeded after ${maxRetries} retries`);
          }
        } else {
          // Different error, don't retry
          throw error;
        }
      }
    }
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.maxRequests);
      const promises = batch.map(async (item) => {
        try {
          const result = await this.executeWithRetry(item.fn);
          item.resolve(result);
        } catch (error) {
          item.reject(error);
        }
      });

      await Promise.all(promises);
      if (this.queue.length > 0) {
        // Adaptive delay based on recent errors
        const delay = this.consecutiveErrors > 0 ? this.calculateBackoff() : this.interval;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    this.processing = false;
  }
}

// Test class for Jupiter routing
class RoutingTester {
  constructor() {
    this.connectionManager = new ConnectionManager();
    this.rateLimiter = new RateLimiter(2, 1000);
    this.routingTokens = [
      USDC_MINT, 
      SOL_MINT, 
      BONK_MINT, 
      USDT_MINT,
      WBTC_MINT,
      WETH_MINT,
      JUP_MINT,
      RAY_MINT,
      MEME_MINT,
      WIF_MINT
    ];
  }

  async initialize() {
    console.log(`Initializing Jupiter with RPC: ${this.connectionManager.getCurrentEndpoint()}`);
    
    // Try up to 3 times to initialize Jupiter
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        this.jupiter = await Jupiter.load({
          connection: this.connectionManager.getConnection(),
          cluster: 'mainnet-beta',
          defaultExchangeVersion: 6,
          routeCacheDuration: 0, // Disable route caching
          // TODO: Add your Jupiter API key for higher rate limits
          // apiKey: 'YOUR_JUPITER_API_KEY',
        });
        console.log('Jupiter initialized successfully');
        return;
      } catch (error) {
        console.log(`\u274c Jupiter initialization failed (attempt ${attempt}/3): ${error.message}`);
        
        if (attempt < 3) {
          // Switch to a different RPC endpoint
          await this.connectionManager.switchEndpoint();
          console.log(`Retrying with new RPC endpoint: ${this.connectionManager.getCurrentEndpoint()}`);
        } else {
          throw new Error(`Failed to initialize Jupiter after 3 attempts: ${error.message}`);
        }
      }
    }
  }

  async testDirectRouting(inputMint, outputMint, amount) {
    console.log('\n=== Testing Direct Routing ===');
    try {
      console.log(`Getting quote for ${inputMint.toString()} to ${outputMint.toString()}, amount: ${amount}`);
      
      // Try up to 3 times with different RPC endpoints if needed
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const routes = await this.rateLimiter.execute(async () => {
            return await this.jupiter.computeRoutes({
              inputMint,
              outputMint,
              amount,
              slippageBps: 150, // 1.5%
              forceFetch: true,
              onlyDirectRoutes: false,
              asLegacyTransaction: false,
            });
          });
          
          if (routes.routesInfos && routes.routesInfos.length > 0) {
            console.log(`✅ Found ${routes.routesInfos.length} direct routes`);
            console.log(`Best route: ${routes.routesInfos[0].outAmount} output tokens (${routes.routesInfos[0].marketInfos.length} hops)`);
            console.log(`Price impact: ${routes.routesInfos[0].priceImpactPct}%`);
            return true;
          } else {
            console.log('❌ No direct routes found');
            return false;
          }
        } catch (error) {
          console.log(`❌ Attempt ${attempt}/3 failed: ${error.message}`);
          
          if (attempt < 3) {
            // Switch to a different RPC endpoint and reinitialize Jupiter
            await this.connectionManager.switchEndpoint();
            await this.initialize();
            console.log(`Retrying with new RPC endpoint: ${this.connectionManager.getCurrentEndpoint()}`);
          } else {
            throw error; // Re-throw on final attempt
          }
        }
      }
    } catch (error) {
      console.log(`❌ Error getting direct routes: ${error.message}`);
      return false;
    }
  }

  async testIntermediateRouting(inputMint, outputMint, amount) {
    console.log('\n=== Testing Intermediate Routing ===');
    try {
      console.log(`Getting quote with intermediate tokens...`);
      
      // Try up to 3 times with different RPC endpoints if needed
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const routes = await this.rateLimiter.execute(async () => {
            return await this.jupiter.computeRoutes({
              inputMint,
              outputMint,
              amount,
              slippageBps: 200, // 2%
              forceFetch: true,
              onlyDirectRoutes: false,
              intermediateTokens: this.routingTokens,
              asLegacyTransaction: false,
            });
          });
          
          if (routes.routesInfos && routes.routesInfos.length > 0) {
            console.log(`✅ Found ${routes.routesInfos.length} routes with intermediate tokens`);
            console.log(`Best route: ${routes.routesInfos[0].outAmount} output tokens (${routes.routesInfos[0].marketInfos.length} hops)`);
            console.log(`Price impact: ${routes.routesInfos[0].priceImpactPct}%`);
            return true;
          } else {
            console.log('❌ No routes found with intermediate tokens');
            return false;
          }
        } catch (error) {
          console.log(`❌ Attempt ${attempt}/3 failed: ${error.message}`);
          
          if (attempt < 3) {
            // Switch to a different RPC endpoint and reinitialize Jupiter
            await this.connectionManager.switchEndpoint();
            await this.initialize();
            console.log(`Retrying with new RPC endpoint: ${this.connectionManager.getCurrentEndpoint()}`);
          } else {
            throw error; // Re-throw on final attempt
          }
        }
      }
    } catch (error) {
      console.log(`❌ Error getting intermediate routes: ${error.message}`);
      return false;
    }
  }

  async testManualRouting(inputMint, outputMint, amount) {
    console.log('\n=== Testing Manual Two-Hop Routing ===');
    try {
      // Add more intermediate tokens to try
      const intermediateTokens = [
        USDC_MINT,  // Try USDC first
        SOL_MINT,   // Then SOL
        BONK_MINT,  // Then BONK
        USDT_MINT,  // Then USDT
        MEME_MINT,  // Then MEME
        WIF_MINT    // Then WIF
      ];
      
      // Try each intermediate token
      for (const intermediateMint of intermediateTokens) {
        const tokenName = intermediateMint.equals(USDC_MINT) ? 'USDC' : 
                          intermediateMint.equals(SOL_MINT) ? 'SOL' : 
                          intermediateMint.equals(BONK_MINT) ? 'BONK' : 
                          intermediateMint.equals(USDT_MINT) ? 'USDT' : 
                          intermediateMint.equals(MEME_MINT) ? 'MEME' : 
                          intermediateMint.equals(WIF_MINT) ? 'WIF' : 'Unknown';
        
        console.log(`\n--- Trying ${tokenName} as intermediate token ---`);
        
        // First hop: Input -> Intermediate
        console.log(`Testing first hop: ${inputMint.toString()} -> ${tokenName}`);
        
        let firstHopRoutes;
        try {
          firstHopRoutes = await this.rateLimiter.execute(async () => {
            return await this.jupiter.computeRoutes({
              inputMint,
              outputMint: intermediateMint,
              amount,
              slippageBps: 100, // 1%
              forceFetch: true,
            });
          });
        } catch (error) {
          console.log(`❌ Error in first hop: ${error.message}`);
          // Try next intermediate token
          continue;
        }
        
        if (!firstHopRoutes.routesInfos || firstHopRoutes.routesInfos.length === 0) {
          console.log(`❌ No routes found for first hop (Input to ${tokenName})`);
          // Try next intermediate token
          continue;
        }
        
        console.log(`✅ Found route for first hop: ${firstHopRoutes.routesInfos[0].outAmount} ${tokenName}`);
        
        // Second hop: Intermediate -> Target
        const secondHopAmount = firstHopRoutes.routesInfos[0].outAmount;
        console.log(`Testing second hop: ${tokenName} -> ${outputMint.toString()}`);
        
        let secondHopRoutes;
        try {
          secondHopRoutes = await this.rateLimiter.execute(async () => {
            return await this.jupiter.computeRoutes({
              inputMint: intermediateMint,
              outputMint,
              amount: secondHopAmount,
              slippageBps: 100, // 1%
              forceFetch: true,
            });
          });
        } catch (error) {
          console.log(`❌ Error in second hop: ${error.message}`);
          // Try next intermediate token
          continue;
        }
        
        if (!secondHopRoutes.routesInfos || secondHopRoutes.routesInfos.length === 0) {
          console.log(`❌ No routes found for second hop (${tokenName} to target token)`);
          // Try next intermediate token
          continue;
        }
        
        console.log(`✅ Found two-hop route: Input -> ${tokenName} -> Target`);
        console.log(`Final output amount: ${secondHopRoutes.routesInfos[0].outAmount}`);
        return true;
      }
      
      // If we get here, all intermediate tokens failed
      console.log('❌ All intermediate tokens failed for manual routing');
      return false;
    } catch (error) {
      console.log(`❌ Error in manual routing: ${error.message}`);
      return false;
    }
  }

  async testRpcFailover(inputMint, outputMint, amount) {
    console.log('\n=== Testing RPC Failover ===');
    
    // Test multiple RPC failovers
    for (let i = 0; i < 3; i++) {
      // Force an RPC switch
      await this.connectionManager.switchEndpoint();
      
      // Reinitialize Jupiter with the new connection
      await this.initialize();
      
      // Try routing with the new RPC
      console.log(`Testing routing with RPC endpoint #${i+1}: ${this.connectionManager.getCurrentEndpoint()}`);
      
      try {
        const routes = await this.rateLimiter.execute(async () => {
          return await this.jupiter.computeRoutes({
            inputMint,
            outputMint,
            amount,
            slippageBps: 150,
            forceFetch: true,
            asLegacyTransaction: false,
          });
        });
        
        if (routes.routesInfos && routes.routesInfos.length > 0) {
          console.log(`\u2705 RPC endpoint #${i+1} successfully found routes`);
          return true;
        } else {
          console.log(`\u274c RPC endpoint #${i+1} found no routes`);
        }
      } catch (error) {
        console.log(`\u274c RPC endpoint #${i+1} failed: ${error.message}`);
        // Mark this endpoint as failed
        this.connectionManager.markEndpointAsFailed(this.connectionManager.getCurrentEndpoint(), error);
      }
    }
    
    console.log('\u274c All tested RPC endpoints failed to find routes');
    return false;
  }

  async runAllTests(tokenAddress) {
    try {
      await this.initialize();
      
      const targetMint = new PublicKey(tokenAddress);
      const amount = 1_000_000_000; // 1 SOL in lamports
      
      console.log(`\n=== TESTING ROUTING FOR TOKEN: ${tokenAddress} ===\n`);
      
      // Test SOL -> Target
      console.log('\n--- Testing SOL -> Target Token ---');
      let directSuccess = await this.testDirectRouting(SOL_MINT, targetMint, amount);
      
      if (!directSuccess) {
        let intermediateSuccess = await this.testIntermediateRouting(SOL_MINT, targetMint, amount);
        
        if (!intermediateSuccess) {
          let manualSuccess = await this.testManualRouting(SOL_MINT, targetMint, amount);
          
          if (!manualSuccess) {
            console.log('\n❌ All routing methods failed for SOL -> Target');
          }
        }
      }
      
      // Test Target -> SOL
      console.log('\n--- Testing Target Token -> SOL ---');
      // For this test, we'll use a smaller amount since we don't know the token's decimals
      const reverseAmount = 1_000_000; // Arbitrary small amount
      
      directSuccess = await this.testDirectRouting(targetMint, SOL_MINT, reverseAmount);
      
      if (!directSuccess) {
        let intermediateSuccess = await this.testIntermediateRouting(targetMint, SOL_MINT, reverseAmount);
        
        if (!intermediateSuccess) {
          let manualSuccess = await this.testManualRouting(targetMint, SOL_MINT, reverseAmount);
          
          if (!manualSuccess) {
            console.log('\n❌ All routing methods failed for Target -> SOL');
          }
        }
      }
      
      // Test RPC failover
      await this.testRpcFailover(SOL_MINT, targetMint, amount);
      
      console.log('\n=== ROUTING TEST COMPLETE ===');
    } catch (error) {
      console.error(`Error running tests: ${error.message}`);
    }
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Please provide a token address to test');
    console.log('Usage: node scripts/test-routing.js <TOKEN_ADDRESS>');
    console.log('Example: node scripts/test-routing.js DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    return;
  }
  
  const tokenAddress = args[0];
  console.log(`\n=== JUPITER ROUTING TEST FOR TOKEN: ${tokenAddress} ===\n`);
  console.log(`Test started at: ${new Date().toISOString()}`);
  console.log(`Using ${RPC_ENDPOINTS.length} RPC endpoints`);
  
  try {
    // Validate token address
    try {
      new PublicKey(tokenAddress);
    } catch (error) {
      console.error(`\u274c Invalid token address: ${tokenAddress}`);
      console.error('Please provide a valid Solana public key');
      return;
    }
    
    const tester = new RoutingTester();
    await tester.runAllTests(tokenAddress);
    
    console.log(`\n=== TEST COMPLETE ===`);
    console.log(`Test completed at: ${new Date().toISOString()}`);
  } catch (error) {
    console.error(`\n\u274c FATAL ERROR: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main().catch(console.error);