const config = require('../../config/config');
const logger = require('../utils/logger');
const database = require('../utils/database');
const sentimentDetector = require('./sentimentDetector');

class TokenScorer {
  constructor() {
    this.weights = config.tokenScoring;
    this.minScore = config.tokenScoring.minScore;
  }

  /**
   * Get the current score weights
   * @returns {Object} The current weights used for scoring
   */
  getScoreWeights() {
    return { ...this.weights };
  }

  /**
   * Update the score weights (used by reinforcement learning)
   * @param {Object} newWeights - The new weights to use
   */
  updateScoreWeights(newWeights) {
    // Update weights
    this.weights = { ...newWeights };
    
    // Log the new weights
    logger.info('Token scoring weights updated:', this.weights);
    
    // Optionally persist to database or config
    database.logEvent(
      'WEIGHTS_UPDATED',
      'Token scoring weights updated',
      { newWeights: this.weights }
    );
  }

  /**
   * Get detailed scores for a token (used by reinforcement learning)
   * @param {string} tokenAddress - The token address
   * @returns {Object} Detailed scores for the token
   */
  async getDetailedScores(tokenAddress) {
    try {
      // This is a simplified implementation
      // In a real implementation, you would fetch the token data and calculate scores
      
      // For now, we'll return the last calculated scores if available
      // or generate placeholder scores
      
      // Try to get from database
      const lastScore = await database.getLastTokenScore(tokenAddress);
      
      if (lastScore) {
        return {
          volumeScore: lastScore.volumeScore || 0,
          liquidityScore: lastScore.liquidityScore || 0,
          priceChangeScore: lastScore.priceChangeScore || 0,
          sentimentScore: lastScore.sentimentScore || 0,
          safetyScore: lastScore.safetyScore || 0,
          totalScore: lastScore.score || 0
        };
      }
      
      // Return placeholder scores
      return {
        volumeScore: 0,
        liquidityScore: 0,
        priceChangeScore: 0,
        sentimentScore: 0,
        safetyScore: 0,
        totalScore: 0
      };
    } catch (error) {
      logger.error(`Error getting detailed scores: ${error.message}`);
      return {
        volumeScore: 0,
        liquidityScore: 0,
        priceChangeScore: 0,
        sentimentScore: 0,
        safetyScore: 0,
        totalScore: 0
      };
    }
  }

  async scoreToken(tokenData) {
    try {
      logger.info(`Scoring token: ${tokenData.baseToken.symbol} (${tokenData.baseToken.address})`);
      
      // Get various scores
      const volumeScore = this.calculateVolumeScore(tokenData);
      const liquidityScore = this.calculateLiquidityScore(tokenData);
      const priceChangeScore = this.calculatePriceChangeScore(tokenData);
      
      // Get sentiment score
      const sentimentScore = await sentimentDetector.calculateSentimentScore(
        tokenData.baseToken.address,
        tokenData.baseToken.symbol
      );
      
      // Calculate weighted score
      const weightedScore = (
        volumeScore * this.weights.volumeWeight +
        liquidityScore * this.weights.liquidityWeight +
        priceChangeScore * this.weights.priceChangeWeight +
        sentimentScore * this.weights.holdersWeight
      );
      
      logger.info(`Token score for ${tokenData.baseToken.symbol}: ${weightedScore.toFixed(2)}`);
      
      const scoreResult = {
        tokenAddress: tokenData.baseToken.address,
        tokenSymbol: tokenData.baseToken.symbol,
        score: weightedScore,
        volumeScore,
        liquidityScore,
        priceChangeScore,
        sentimentScore,
        isGoodBuy: weightedScore >= this.minScore,
      };
      
      // Save score to database for future reference
      await database.saveTokenScore(scoreResult);
      
      return scoreResult;
    } catch (error) {
      logger.error(`Error scoring token: ${error.message}`);
      return {
        tokenAddress: tokenData.baseToken.address,
        tokenSymbol: tokenData.baseToken.symbol,
        score: 0,
        isGoodBuy: false,
      };
    }
  }

  calculateVolumeScore(tokenData) {
    try {
      const volume24h = parseFloat(tokenData.volume?.h24 || 0);
      const minVolume = config.trading.minVolumeUsd;
      
      // Score based on volume (0 to 1)
      // 0 = 0, minVolume = 0.5, 10*minVolume = 1
      let score = 0;
      if (volume24h > 0) {
        score = 0.5 * (volume24h / minVolume);
        score = Math.min(1, score);
      }
      
      return score;
    } catch (error) {
      logger.error(`Error calculating volume score: ${error.message}`);
      return 0;
    }
  }

  calculateLiquidityScore(tokenData) {
    try {
      const liquidity = parseFloat(tokenData.liquidity?.usd || 0);
      const minLiquidity = config.trading.minLiquidityUsd;
      
      // Score based on liquidity (0 to 1)
      // 0 = 0, minLiquidity = 0.5, 5*minLiquidity = 1
      let score = 0;
      if (liquidity > 0) {
        score = 0.5 * (liquidity / minLiquidity);
        score = Math.min(1, score);
      }
      
      return score;
    } catch (error) {
      logger.error(`Error calculating liquidity score: ${error.message}`);
      return 0;
    }
  }

  calculatePriceChangeScore(tokenData) {
    try {
      const priceChange1h = parseFloat(tokenData.priceChange?.h1 || 0);
      const priceChange24h = parseFloat(tokenData.priceChange?.h24 || 0);
      
      // Score based on price change (0 to 1)
      // We want positive price change, but not too extreme (potential dump)
      // Optimal range: 10% to 100% for 24h
      
      let score1h = 0;
      if (priceChange1h > 0) {
        // 0% = 0, 5% = 0.5, 20%+ = 1.0
        score1h = priceChange1h / 20;
        score1h = Math.min(1, score1h);
      }
      
      let score24h = 0;
      if (priceChange24h > 0) {
        // 0% = 0, 25% = 0.5, 100%+ = 1.0
        score24h = priceChange24h / 100;
        score24h = Math.min(1, score24h);
      }
      
      // Combine scores (more weight to 1h change for recency)
      return score1h * 0.6 + score24h * 0.4;
    } catch (error) {
      logger.error(`Error calculating price change score: ${error.message}`);
      return 0;
    }
  }

  async scoreBatch(tokens) {
    const scoredTokens = [];
    
    for (const token of tokens) {
      try {
        const score = await this.scoreToken(token);
        scoredTokens.push({
          token,
          score: score.score,
          details: score,
        });
      } catch (error) {
        logger.error(`Error scoring token in batch: ${error.message}`);
      }
    }
    
    // Sort by score (highest first)
    return scoredTokens.sort((a, b) => b.score - a.score);
  }

  async getTopScoringTokens(tokens, minScore = null, limit = 5) {
    const minScoreToUse = minScore !== null ? minScore : this.minScore;
    
    // Score all tokens
    const scoredTokens = await this.scoreBatch(tokens);
    
    // Filter by minimum score and take top N
    return scoredTokens
      .filter(item => item.score >= minScoreToUse)
      .slice(0, limit);
  }
}

module.exports = new TokenScorer();