/**
 * This script implements fallback routing in your swap executor with RPC endpoint failover.
 * It combines both routing fallbacks and RPC endpoint fallbacks for maximum reliability.
 */

const fs = require('fs');
const path = require('path');

// Get the project root directory
const projectRoot = path.resolve(__dirname, '..');

console.log('=== IMPLEMENTING FALLBACK ROUTING WITH RPC FAILOVER ===');

// Define the healthy RPC endpoints from the health check
const healthyRpcEndpoints = [
  'https://hidden-indulgent-card.solana-mainnet.quiknode.pro/88200bf9df13e5a27afeadbd45afa50be60273b9/',
  'https://mainnet.helius-rpc.com/?api-key=f7e0528e-7e2d-404f-8ae7-e774405c422f',
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com'
];

// Create the connection manager code
const connectionManagerCode = `
/**
 * ConnectionManager handles RPC endpoint failover for Solana connections.
 * It automatically switches to backup endpoints when the primary fails.
 */
class ConnectionManager {
  constructor(logger) {
    this.logger = logger || console;
    this.endpoints = [
      '${healthyRpcEndpoints[0]}', // Primary (fastest)
      '${healthyRpcEndpoints[1]}', // First backup
      '${healthyRpcEndpoints[2]}', // Second backup
      '${healthyRpcEndpoints[3]}', // Last resort
    ];
    this.currentEndpointIndex = 0;
    this.connection = new Connection(this.endpoints[0], 'confirmed');
    this.failureCount = 0;
    this.lastFailoverTime = 0;
    this.isFailingOver = false;
  }

  /**
   * Get the current connection
   */
  getConnection() {
    return this.connection;
  }

  /**
   * Get the current RPC endpoint URL
   */
  getCurrentEndpoint() {
    return this.endpoints[this.currentEndpointIndex];
  }

  /**
   * Execute a connection method with automatic failover
   * @param {Function} method - The connection method to execute
   * @param {Array} args - Arguments to pass to the method
   * @returns {Promise<any>} - The result of the method
   */
  async executeWithFailover(method, ...args) {
    try {
      return await method.apply(this.connection, args);
    } catch (error) {
      // Check if error is likely due to RPC issues
      if (this.isRpcError(error) && !this.isFailingOver) {
        this.failureCount++;
        
        // If we've had multiple failures in a short time, try failover
        if (this.failureCount >= 3 || 
            (Date.now() - this.lastFailoverTime > 60000 && this.failureCount >= 1)) {
          return await this.failover(method, ...args);
        }
      }
      throw error;
    }
  }

  /**
   * Check if an error is likely an RPC-related error
   */
  isRpcError(error) {
    const errorString = error.toString().toLowerCase();
    return (
      errorString.includes('fetch failed') ||
      errorString.includes('timeout') ||
      errorString.includes('429') ||
      errorString.includes('too many requests') ||
      errorString.includes('server error') ||
      errorString.includes('service unavailable') ||
      errorString.includes('internal server error') ||
      errorString.includes('bad gateway') ||
      errorString.includes('gateway timeout')
    );
  }

  /**
   * Switch to the next available endpoint
   */
  async failover(method, ...args) {
    this.isFailingOver = true;
    try {
      const oldEndpoint = this.endpoints[this.currentEndpointIndex];
      this.currentEndpointIndex = (this.currentEndpointIndex + 1) % this.endpoints.length;
      const newEndpoint = this.endpoints[this.currentEndpointIndex];
      
      this.logger.warn(`RPC failover: Switching from ${oldEndpoint} to ${newEndpoint}`);
      this.connection = new Connection(newEndpoint, 'confirmed');
      this.lastFailoverTime = Date.now();
      this.failureCount = 0;
      
      // Try the operation with the new connection
      return await method.apply(this.connection, args);
    } catch (error) {
      // If we've tried all endpoints, reset to the first one
      if (this.currentEndpointIndex === this.endpoints.length - 1) {
        this.logger.error('All RPC endpoints failed. Resetting to primary endpoint.');
        this.currentEndpointIndex = 0;
        this.connection = new Connection(this.endpoints[0], 'confirmed');
      }
      throw error;
    } finally {
      this.isFailingOver = false;
    }
  }
}
`;

// Create the Jupiter quote method with fallback routing
const jupiterQuoteMethod = `async getJupiterQuote(inputMint, outputMint, amountInLamports, slippageToUse) {
  try {
    this.logger.info(\`Getting Jupiter quote for \${inputMint.toString()} to \${outputMint.toString()}, amount: \${amountInLamports}, slippage: \${slippageToUse}\`);
    
    // Try to get a direct quote first
    try {
      const routes = await this.jupiterRateLimiter.execute(async () => {
        return await this.jupiterInstance.computeRoutes({
          inputMint,
          outputMint,
          amount: amountInLamports,
          slippageBps: Math.floor(slippageToUse * 100),
          forceFetch: true,
          onlyDirectRoutes: false,
        });
      });
      
      if (routes.routesInfos && routes.routesInfos.length > 0) {
        this.logger.info(\`Found \${routes.routesInfos.length} direct routes\`);
        return routes;
      }
    } catch (error) {
      this.logger.warn(\`Error getting direct routes: \${error.message}\`);
    }
    
    // If no direct routes, try with intermediate tokens
    this.logger.info('No direct routes found. Trying with intermediate tokens...');
    try {
      const routingTokens = this.config.trading.jupiter.routingTokens.map(t => new PublicKey(t));
      
      const alternativeRoutes = await this.jupiterRateLimiter.execute(async () => {
        return await this.jupiterInstance.computeRoutes({
          inputMint,
          outputMint,
          amount: amountInLamports,
          slippageBps: Math.floor(slippageToUse * 150), // Increase slippage for alternative routes
          forceFetch: true,
          onlyDirectRoutes: false,
          intermediateTokens: routingTokens,
        });
      });
      
      if (alternativeRoutes.routesInfos && alternativeRoutes.routesInfos.length > 0) {
        this.logger.info(\`Found \${alternativeRoutes.routesInfos.length} alternative routes\`);
        return alternativeRoutes;
      }
    } catch (error) {
      this.logger.warn(\`Error getting alternative routes: \${error.message}\`);
    }
    
    // If still no routes, try manual two-hop approach
    this.logger.info('No alternative routes found. Trying manual two-hop approach...');
    try {
      return await this.findManualRoute(inputMint, outputMint, amountInLamports, slippageToUse);
    } catch (error) {
      this.logger.error(\`All routing attempts failed: \${error.message}\`);
      throw new Error(\`No routes found between \${inputMint.toString()} and \${outputMint.toString()}: \${error.message}\`);
    }
  } catch (error) {
    this.logger.error(\`Error getting Jupiter quote: \${error.message}\`);
    throw error;
  }
}`;

// Manual route finding method
const manualRouteMethod = `async findManualRoute(inputMint, outputMint, amountInLamports, slippageToUse) {
  try {
    // Try SOL -> USDC -> Target token
    const usdcMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    
    // First hop: Input -> USDC
    const firstHopRoutes = await this.jupiterRateLimiter.execute(async () => {
      return await this.jupiterInstance.computeRoutes({
        inputMint,
        outputMint: usdcMint,
        amount: amountInLamports,
        slippageBps: Math.floor(slippageToUse * 150),
        forceFetch: true,
      });
    });
    
    if (!firstHopRoutes.routesInfos || firstHopRoutes.routesInfos.length === 0) {
      this.logger.info('No routes found for first hop (Input to USDC)');
      throw new Error('No routes found for first hop');
    }
    
    this.logger.info(\`Found route for first hop: \${firstHopRoutes.routesInfos[0].outAmount} USDC\`);
    
    // Second hop: USDC -> Target
    const secondHopAmount = firstHopRoutes.routesInfos[0].outAmount;
    const secondHopRoutes = await this.jupiterRateLimiter.execute(async () => {
      return await this.jupiterInstance.computeRoutes({
        inputMint: usdcMint,
        outputMint,
        amount: secondHopAmount,
        slippageBps: Math.floor(slippageToUse * 150),
        forceFetch: true,
      });
    });
    
    if (!secondHopRoutes.routesInfos || secondHopRoutes.routesInfos.length === 0) {
      this.logger.info('No routes found for second hop (USDC to target token)');
      
      // Try BONK as intermediate
      this.logger.info('Trying BONK as intermediate...');
      const bonkMint = new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
      
      const bonkHopRoutes = await this.jupiterRateLimiter.execute(async () => {
        return await this.jupiterInstance.computeRoutes({
          inputMint: usdcMint,
          outputMint: bonkMint,
          amount: secondHopAmount,
          slippageBps: Math.floor(slippageToUse * 150),
          forceFetch: true,
        });
      });
      
      if (!bonkHopRoutes.routesInfos || bonkHopRoutes.routesInfos.length === 0) {
        this.logger.info('No routes found for USDC to BONK');
        throw new Error('No viable routes found');
      }
      
      const bonkAmount = bonkHopRoutes.routesInfos[0].outAmount;
      const finalHopRoutes = await this.jupiterRateLimiter.execute(async () => {
        return await this.jupiterInstance.computeRoutes({
          inputMint: bonkMint,
          outputMint,
          amount: bonkAmount,
          slippageBps: Math.floor(slippageToUse * 150),
          forceFetch: true,
        });
      });
      
      if (!finalHopRoutes.routesInfos || finalHopRoutes.routesInfos.length === 0) {
        this.logger.info('No routes found for BONK to target token');
        throw new Error('No viable routes found');
      }
      
      this.logger.info(\`Found three-hop route: Input -> USDC -> BONK -> Target\`);
      
      // Note: This is a simplified approach. In a real implementation, you would need to execute these swaps sequentially
      // This just returns the final route information for the UI/logging purposes
      return {
        routesInfos: [
          {
            ...finalHopRoutes.routesInfos[0],
            inAmount: amountInLamports,
            outAmount: finalHopRoutes.routesInfos[0].outAmount,
            marketInfos: [
              ...firstHopRoutes.routesInfos[0].marketInfos,
              ...bonkHopRoutes.routesInfos[0].marketInfos,
              ...finalHopRoutes.routesInfos[0].marketInfos
            ],
            priceImpactPct: (
              parseFloat(firstHopRoutes.routesInfos[0].priceImpactPct) +
              parseFloat(bonkHopRoutes.routesInfos[0].priceImpactPct) +
              parseFloat(finalHopRoutes.routesInfos[0].priceImpactPct)
            ).toString(),
          }
        ]
      };
    }
    
    this.logger.info(\`Found two-hop route: Input -> USDC -> Target\`);
    
    // Note: This is a simplified approach. In a real implementation, you would need to execute these swaps sequentially
    // This just returns the final route information for the UI/logging purposes
    return {
      routesInfos: [
        {
          ...secondHopRoutes.routesInfos[0],
          inAmount: amountInLamports,
          outAmount: secondHopRoutes.routesInfos[0].outAmount,
          marketInfos: [
            ...firstHopRoutes.routesInfos[0].marketInfos,
            ...secondHopRoutes.routesInfos[0].marketInfos
          ],
          priceImpactPct: (
            parseFloat(firstHopRoutes.routesInfos[0].priceImpactPct) +
            parseFloat(secondHopRoutes.routesInfos[0].priceImpactPct)
          ).toString(),
        }
      ]
    };
  } catch (error) {
    this.logger.error(\`Error in manual routing: \${error.message}\`);
    throw new Error(\`No routes found: \${error.message}\`);
  }
}`;

// Optimal slippage method
const optimalSlippageMethod = `async getOptimalSlippage(tokenAddress) {
  try {
    // Your existing code to get slippage from Jupiter
    // ...
  } catch (error) {
    this.logger.warn(\`Jupiter failed to calculate optimal slippage: \${error.message}. Using default.\`);
    
    // Increase default slippage for tokens that have routing issues
    if (error.message.includes('No routes found')) {
      this.logger.info(\`Increasing default slippage for token with routing issues: \${tokenAddress}\`);
      return this.defaultSlippage * 1.5; // 50% higher slippage
    }
    
    return this.defaultSlippage;
  }
}`;

// Jupiter initialization code
const jupiterInitCode = `// In your initialization code
this.jupiterInstance = await Jupiter.load({
  connection: this.connectionManager.getConnection(), // Use the connection manager
  cluster: 'mainnet-beta',
  defaultExchangeVersion: 6, // Use the latest Jupiter version
});

// Update connection when RPC endpoint changes
this.connectionManager.onEndpointChange = (newConnection) => {
  this.jupiterInstance = await Jupiter.load({
    connection: newConnection,
    cluster: 'mainnet-beta',
    defaultExchangeVersion: 6,
  });
}`;

// Generate the implementation file
const implementationCode = `
/**
 * This file contains the implementation for fallback routing with RPC endpoint failover.
 * Copy and paste these methods into your swap executor class.
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const { Jupiter } = require('@jup-ag/core');

${connectionManagerCode}

// Add this to your SwapExecutor class:

${jupiterQuoteMethod}

${manualRouteMethod}

${optimalSlippageMethod}

// Update your initialization code:
${jupiterInitCode}

/**
 * IMPLEMENTATION INSTRUCTIONS:
 * 
 * 1. Create a new file called 'connectionManager.js' in your project's src/utils directory
 *    and copy the ConnectionManager class into it.
 * 
 * 2. In your swap executor file:
 *    - Import the ConnectionManager: const { ConnectionManager } = require('../utils/connectionManager');
 *    - Replace your Connection initialization with the ConnectionManager
 *    - Replace the getJupiterQuote method with the one provided
 *    - Add the findManualRoute method
 *    - Update the getOptimalSlippage method
 *    - Update your Jupiter initialization code
 * 
 * 3. Add these tokens to your config.js file under trading.jupiter.routingTokens:
 *    [
 *      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
 *      "So11111111111111111111111111111111111111112",   // SOL
 *      "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
 *      "7i5KKsX2weiTkry7jA4ZwSuXGhs5eJBEjY8vVxR4pfRx"  // USDT
 *    ]
 */
`;

// Write the implementation to a file
const implementationFilePath = path.join(projectRoot, 'fallback-routing-implementation.js');
fs.writeFileSync(implementationFilePath, implementationCode);

console.log(`\nImplementation file created at: ${implementationFilePath}`);
console.log('\n=== IMPLEMENTATION INSTRUCTIONS ===');
console.log('1. Copy the ConnectionManager class to a new file in your src/utils directory');
console.log('2. Update your swap executor with the provided methods');
console.log('3. Add the recommended routing tokens to your config');
console.log('\nFor detailed instructions, see the comments at the end of the implementation file.');
console.log('\nThe implementation uses these healthy RPC endpoints from your health check:');
healthyRpcEndpoints.forEach((endpoint, index) => {
  console.log(`${index + 1}. ${endpoint}`);
});