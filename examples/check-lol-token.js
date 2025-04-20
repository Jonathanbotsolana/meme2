/**
 * Utility script to check LOL token price and liquidity
 */

require('dotenv').config();
const logger = require('../src/utils/logger');
const dexScreenerClient = require('../src/utils/dexScreenerClient');
const onChainAnalyzer = require('../src/modules/onChainAnalyzer');

const LOL_TOKEN_ADDRESS = 'LoL1RDQiUfifC2BX28xaef6r2G8ES8SEzgrzThJemMv';

async function checkLolToken() {
  try {
    logger.info('Checking LOL token information');
    
    // Get token info from DexScreener
    logger.info('Fetching token info from DexScreener...');
    const tokenInfo = await dexScreenerClient.getTokenInfo(LOL_TOKEN_ADDRESS);
    
    if (tokenInfo) {
      logger.info('LOL Token Information:');
      logger.info(`Name: ${tokenInfo.name}`);
      logger.info(`Symbol: ${tokenInfo.symbol}`);
      logger.info(`Address: ${tokenInfo.address}`);
      logger.info(`Price USD: $${tokenInfo.priceUsd || 'Unknown'}`);
      logger.info(`Price SOL: ${tokenInfo.priceSol || 'Unknown'} SOL`);
      logger.info(`Market Cap: $${tokenInfo.marketCap || 'Unknown'}`);
    } else {
      logger.warn('Could not fetch token info from DexScreener');
    }
    
    // Check active pairs
    logger.info('\nChecking active trading pairs...');
    const pairsResult = await dexScreenerClient.checkActivePairs(LOL_TOKEN_ADDRESS, {
      minLiquidityUsd: 1000,
      minVolumeUsd: 100
    });
    
    if (pairsResult.hasActivePairs) {
      logger.info(`Found ${pairsResult.pairs.length} active trading pairs:`);
      
      pairsResult.pairs.forEach((pair, index) => {
        logger.info(`\nPair ${index + 1}: ${pair.baseToken.symbol}/${pair.quoteToken.symbol} on ${pair.dexId}`);
        logger.info(`Pair Address: ${pair.pairAddress}`);
        logger.info(`Liquidity: $${pair.liquidity?.usd || 'Unknown'}`);
        logger.info(`24h Volume: $${pair.volume?.h24 || 'Unknown'}`);
        logger.info(`Price: $${pair.priceUsd || 'Unknown'}`);
        logger.info(`Price Change 24h: ${pair.priceChange?.h24 || 'Unknown'}%`);
      });
      
      if (pairsResult.bestPair) {
        logger.info(`\nBest pair: ${pairsResult.bestPair.baseToken.symbol}/${pairsResult.bestPair.quoteToken.symbol} on ${pairsResult.bestPair.dexId}`);
      }
    } else {
      logger.warn('No active trading pairs found');
      if (pairsResult.reason) {
        logger.warn(`Reason: ${pairsResult.reason}`);
      }
    }
    
    // Check on-chain data
    logger.info('\nAnalyzing on-chain data...');
    const onChainData = await onChainAnalyzer.analyzeToken(LOL_TOKEN_ADDRESS);
    
    if (onChainData) {
      logger.info('On-chain Analysis:');
      logger.info(`Supply: ${onChainData.supply || 'Unknown'}`);
      logger.info(`Decimals: ${onChainData.decimals || 'Unknown'}`);
      logger.info(`Holder Count: ${onChainData.holderCount || 'Unknown'}`);
      
      // Check Raydium pool
      const raydiumPoolExists = await onChainAnalyzer.checkRaydiumPool(LOL_TOKEN_ADDRESS);
      logger.info(`Raydium Pool Exists: ${raydiumPoolExists ? 'Yes' : 'No'}`);
      
      if (raydiumPoolExists) {
        const raydiumLiquidity = await onChainAnalyzer.getRaydiumLiquidity(LOL_TOKEN_ADDRESS);
        logger.info(`Raydium Liquidity: $${raydiumLiquidity || 'Unknown'}`);
      }
    } else {
      logger.warn('Could not fetch on-chain data');
    }
    
  } catch (error) {
    logger.error(`Error checking LOL token: ${error.message}`);
  }
}

// Execute the check
checkLolToken().then(() => {
  logger.info('LOL token check completed');
  process.exit(0);
}).catch(error => {
  logger.error(`Unhandled error: ${error.message}`);
  process.exit(1);
});