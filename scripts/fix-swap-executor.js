/**
 * This script provides instructions for modifying the swapExecutor.js file
 * to implement a fallback routing mechanism for Jupiter.
 * 
 * Run this script to see the changes you need to make to fix the routing issues.
 */

console.log('=== SWAP EXECUTOR FIXES FOR JUPITER ROUTING ISSUES ===');
console.log('\nFollow these steps to modify your swapExecutor.js file:\n');

console.log('1. Find the method that gets Jupiter quotes (usually called getJupiterQuote or similar)');
console.log('2. Replace it with the following implementation that includes fallback routing:\n');

console.log(`async getJupiterQuote(inputMint, outputMint, amountInLamports, slippageToUse) {
  try {
    logger.info(`Getting Jupiter quote for ${inputMint.toString()} to ${outputMint.toString()}, amount: ${amountInLamports}, slippage: ${slippageToUse}`);
    
    // Try to get a direct quote first
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
      logger.info(`Found ${routes.routesInfos.length} direct routes`);
      return routes;
    }
    
    // If no direct routes, try with intermediate tokens
    logger.info('No direct routes found. Trying with intermediate tokens...');
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
      logger.info(`Found ${alternativeRoutes.routesInfos.length} alternative routes`);
      return alternativeRoutes;
    }
    
    // If still no routes, try manual two-hop approach
    logger.info('No alternative routes found. Trying manual two-hop approach...');
    return await this.findManualRoute(inputMint, outputMint, amountInLamports, slippageToUse);
  } catch (error) {
    logger.error(`Error getting Jupiter quote: ${error.message}`);
    throw error;
  }
}`);

console.log('\n3. Add this new method to implement manual routing:\n');

console.log(`async findManualRoute(inputMint, outputMint, amountInLamports, slippageToUse) {
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
      logger.info('No routes found for first hop (Input to USDC)');
      throw new Error('No routes found for first hop');
    }
    
    logger.info(`Found route for first hop: ${firstHopRoutes.routesInfos[0].outAmount} USDC`);
    
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
      logger.info('No routes found for second hop (USDC to target token)');
      
      // Try BONK as intermediate
      logger.info('Trying BONK as intermediate...');
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
        logger.info('No routes found for USDC to BONK');
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
        logger.info('No routes found for BONK to target token');
        throw new Error('No viable routes found');
      }
      
      logger.info(`Found three-hop route: Input -> USDC -> BONK -> Target`);
      
      // Create a synthetic route that combines all three hops
      // This is a simplified approach - in a real implementation you would need to execute these swaps sequentially
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
    
    logger.info(`Found two-hop route: Input -> USDC -> Target`);
    
    // Create a synthetic route that combines both hops
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
    logger.error(`Error in manual routing: ${error.message}`);
    throw new Error(`No routes found: ${error.message}`);
  }
}`);

console.log('\n4. Update the getOptimalSlippage method to handle routing failures better:\n');

console.log(`async getOptimalSlippage(tokenAddress) {
  try {
    // Try to get slippage from Jupiter
    // ...existing code...
  } catch (error) {
    logger.warn(`Jupiter failed to calculate optimal slippage: ${error.message}. Using default.`);
    
    // Increase default slippage for tokens that have routing issues
    if (error.message.includes('No routes found')) {
      logger.info(`Increasing default slippage for token with routing issues: ${tokenAddress}`);
      return this.defaultSlippage * 1.5; // 50% higher slippage
    }
    
    return this.defaultSlippage;
  }
}`);

console.log('\n5. Make sure to update your Jupiter initialization to use the latest version:\n');

console.log(`// In your initialization code
this.jupiterInstance = await Jupiter.load({
  connection: this.connection,
  cluster: 'mainnet-beta',
  defaultExchangeVersion: 6, // Use the latest Jupiter version
});`);

console.log('\nAfter making these changes, your bot should be able to handle tokens with limited liquidity or complex routing requirements much better.');