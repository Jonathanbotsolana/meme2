const axios = require('axios');
const logger = require('../utils/logger');
const database = require('../utils/database');

class SentimentDetector {
  constructor() {
    this.sentimentScores = new Map();
  }

  // Calculate sentiment score based on various factors
  async calculateSentimentScore(tokenAddress, tokenSymbol) {
    try {
      logger.info(`Calculating sentiment score for ${tokenSymbol} (${tokenAddress})`);
      
      // If we already have a recent score, return it
      if (this.sentimentScores.has(tokenAddress)) {
        const { score, timestamp } = this.sentimentScores.get(tokenAddress);
        const ageInMinutes = (Date.now() - timestamp) / (60 * 1000);
        
        // Use cached score if less than 15 minutes old
        if (ageInMinutes < 15) {
          logger.debug(`Using cached sentiment score for ${tokenSymbol}: ${score}`);
          return score;
        }
      }
      
      // Calculate new sentiment score
      const priceMovementScore = await this.getPriceMovementScore(tokenAddress);
      const socialMediaScore = await this.getSocialMediaScore(tokenSymbol);
      const tradingVolumeScore = await this.getTradingVolumeScore(tokenAddress);
      
      // Weighted average of different factors
      const sentimentScore = (
        priceMovementScore * 0.4 +
        socialMediaScore * 0.4 +
        tradingVolumeScore * 0.2
      );
      
      // Store the score with timestamp
      this.sentimentScores.set(tokenAddress, {
        score: sentimentScore,
        timestamp: Date.now()
      });
      
      logger.info(`Sentiment score for ${tokenSymbol}: ${sentimentScore.toFixed(2)}`);
      return sentimentScore;
    } catch (error) {
      logger.error(`Error calculating sentiment score: ${error.message}`);
      return 0.5; // Neutral score as fallback
    }
  }

  // Get score based on recent price movements
  async getPriceMovementScore(tokenAddress) {
    try {
      // Get token data from database
      const tokenData = await database.getToken(tokenAddress);
      if (!tokenData) {
        return 0.5; // Neutral score if no data
      }
      
      // Calculate score based on price change
      const priceChange24h = tokenData.price_change_24h || 0;
      
      // Map price change to a 0-1 score
      // -50% or worse = 0, +100% or better = 1, 0% = 0.5
      let score = 0.5 + (priceChange24h / 200);
      score = Math.max(0, Math.min(1, score)); // Clamp between 0 and 1
      
      return score;
    } catch (error) {
      logger.error(`Error getting price movement score: ${error.message}`);
      return 0.5;
    }
  }

  // Get score based on social media mentions and sentiment
  async getSocialMediaScore(tokenSymbol) {
    try {
      // This is a simplified implementation
      // In a real-world scenario, you would integrate with Twitter/X API, Discord, Telegram, etc.
      
      // For now, we'll simulate social media sentiment with a random score
      // biased slightly positive for new tokens (assumption that new tokens get some hype)
      const randomFactor = Math.random() * 0.4; // Random value between 0 and 0.4
      const baseScore = 0.5; // Neutral base
      const socialScore = baseScore + randomFactor;
      
      logger.debug(`Simulated social media score for ${tokenSymbol}: ${socialScore.toFixed(2)}`);
      return socialScore;
    } catch (error) {
      logger.error(`Error getting social media score: ${error.message}`);
      return 0.5;
    }
  }

  // Get score based on trading volume patterns
  async getTradingVolumeScore(tokenAddress) {
    try {
      // Get token data from database
      const tokenData = await database.getToken(tokenAddress);
      if (!tokenData) {
        return 0.5; // Neutral score if no data
      }
      
      // Calculate score based on volume
      const volume24h = tokenData.volume_24h || 0;
      const liquidity = tokenData.liquidity || 0;
      
      if (liquidity === 0) return 0.5;
      
      // Volume to liquidity ratio as a sentiment indicator
      // Higher ratio = more trading activity relative to liquidity = more interest
      const volumeToLiquidityRatio = volume24h / liquidity;
      
      // Map ratio to score: 0 = 0.5, 1+ = 1.0
      let score = 0.5 + (volumeToLiquidityRatio * 0.5);
      score = Math.min(1, score); // Cap at 1.0
      
      return score;
    } catch (error) {
      logger.error(`Error getting trading volume score: ${error.message}`);
      return 0.5;
    }
  }

  // Analyze sentiment for multiple tokens and return sorted results
  async analyzeBatch(tokens) {
    const results = [];
    
    for (const token of tokens) {
      try {
        const sentimentScore = await this.calculateSentimentScore(
          token.baseToken.address,
          token.baseToken.symbol
        );
        
        results.push({
          token,
          sentimentScore
        });
      } catch (error) {
        logger.error(`Error analyzing sentiment for token ${token.baseToken.symbol}: ${error.message}`);
      }
    }
    
    // Sort by sentiment score (highest first)
    return results.sort((a, b) => b.sentimentScore - a.sentimentScore);
  }
}

module.exports = new SentimentDetector();