/**
 * Reinforcement Learning Feedback Loop Module
 * 
 * This module tracks rejected tokens, monitors their performance,
 * and uses the data to improve the bot's decision-making over time.
 */

const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const config = require('../../config/config');
const logger = require('../utils/logger');
const database = require('../utils/database');
const marketScanner = require('./marketScanner');
const tokenScorer = require('./tokenScorer');

class ReinforcementLearning {
  constructor() {
    this.rejectedTokens = [];
    this.missedOpportunities = [];
    this.memoryFilePath = path.join(__dirname, '../../data/reinforcement-memory.json');
    this.learningRate = 0.05; // How quickly the system adapts to new information
    this.initialized = false;
    this.performanceThresholds = {
      // Thresholds to consider a token a "missed opportunity"
      '1h': 0.5,  // 50% gain in 1 hour
      '4h': 0.75, // 75% gain in 4 hours
      '24h': 1.0  // 100% gain in 24 hours
    };
  }

  /**
   * Initialize the reinforcement learning module
   */
  async initialize() {
    try {
      logger.info('Initializing Reinforcement Learning module...');
      
      // Create data directory if it doesn't exist
      const dataDir = path.join(__dirname, '../../data');
      try {
        await fs.mkdir(dataDir, { recursive: true });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      
      // Load previous memory if it exists
      try {
        const data = await fs.readFile(this.memoryFilePath, 'utf8');
        const memory = JSON.parse(data);
        this.rejectedTokens = memory.rejectedTokens || [];
        this.missedOpportunities = memory.missedOpportunities || [];
        logger.info(`Loaded ${this.rejectedTokens.length} rejected tokens and ${this.missedOpportunities.length} missed opportunities from memory`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.error(`Error loading reinforcement memory: ${err.message}`);
        } else {
          logger.info('No previous reinforcement memory found, starting fresh');
          // Initialize with empty data
          await this.saveMemory();
        }
      }
      
      // Set up scheduled tasks for monitoring rejected tokens
      this.setupScheduledTasks();
      
      this.initialized = true;
      logger.info('Reinforcement Learning module initialized successfully');
      return true;
    } catch (error) {
      logger.error(`Reinforcement Learning initialization error: ${error.message}`);
      return false;
    }
  }

  /**
   * Set up scheduled tasks for monitoring rejected tokens
   */
  setupScheduledTasks() {
    // Check performance of rejected tokens every hour
    cron.schedule('0 * * * *', async () => {
      await this.checkRejectedTokenPerformance('1h');
    });
    
    // Check performance of rejected tokens every 4 hours
    cron.schedule('0 */4 * * *', async () => {
      await this.checkRejectedTokenPerformance('4h');
    });
    
    // Check performance of rejected tokens every 24 hours
    cron.schedule('0 0 * * *', async () => {
      await this.checkRejectedTokenPerformance('24h');
      // Apply learning from missed opportunities once per day
      await this.applyLearning();
    });
    
    // Clean up old rejected tokens (older than 3 days) once per day
    cron.schedule('0 1 * * *', async () => {
      await this.cleanupOldRejectedTokens();
    });
    
    logger.info('Reinforcement Learning scheduled tasks set up');
  }

  /**
   * Track a token that was rejected by the bot
   * @param {Object} token - The token object
   * @param {string} reason - Reason for rejection
   * @param {Object} scores - Various scores that led to the decision
   */
  async trackRejectedToken(token, reason, scores) {
    if (!this.initialized) {
      logger.warn('Reinforcement Learning module not initialized');
      return;
    }
    
    try {
      const tokenAddress = token.baseToken?.address || token.address;
      const tokenSymbol = token.baseToken?.symbol || token.symbol;
      
      // Check if token is already being tracked
      const existingIndex = this.rejectedTokens.findIndex(t => t.tokenAddress === tokenAddress);
      
      if (existingIndex >= 0) {
        // Update existing entry
        this.rejectedTokens[existingIndex].reasons.push(reason);
        logger.debug(`Updated existing rejected token tracking for ${tokenSymbol}`);
      } else {
        // Create new entry
        const rejectedToken = {
          tokenAddress,
          tokenSymbol,
          timestamp: Date.now(),
          reasons: [reason],
          scores: { ...scores },
          initialPrice: token.price || 0,
          performance: {
            '1h': null,
            '4h': null,
            '24h': null
          },
          wasChecked: {
            '1h': false,
            '4h': false,
            '24h': false
          }
        };
        
        this.rejectedTokens.push(rejectedToken);
        logger.info(`Tracking rejected token: ${tokenSymbol} (${tokenAddress}) - Reason: ${reason}`);
        
        // Save to memory file
        await this.saveMemory();
      }
    } catch (error) {
      logger.error(`Error tracking rejected token: ${error.message}`);
    }
  }

  /**
   * Check the performance of rejected tokens after a specific time period
   * @param {string} timeframe - The timeframe to check ('1h', '4h', or '24h')
   */
  async checkRejectedTokenPerformance(timeframe) {
    if (!this.initialized) {
      logger.warn('Reinforcement Learning module not initialized');
      return;
    }
    
    try {
      logger.info(`Checking ${timeframe} performance of rejected tokens...`);
      
      const now = Date.now();
      const timeframeMs = {
        '1h': 60 * 60 * 1000,
        '4h': 4 * 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000
      }[timeframe];
      
      // Filter tokens that need to be checked for this timeframe
      const tokensToCheck = this.rejectedTokens.filter(token => {
        const timeSinceRejection = now - token.timestamp;
        return timeSinceRejection >= timeframeMs && !token.wasChecked[timeframe];
      });
      
      if (tokensToCheck.length === 0) {
        logger.debug(`No rejected tokens to check for ${timeframe} performance`);
        return;
      }
      
      logger.info(`Checking ${timeframe} performance for ${tokensToCheck.length} rejected tokens`);
      
      // Check each token's performance
      for (const token of tokensToCheck) {
        try {
          // Get current price from market scanner
          const currentPrice = await this.getCurrentTokenPrice(token.tokenAddress);
          
          if (currentPrice && token.initialPrice) {
            // Calculate performance (% change)
            const performance = (currentPrice - token.initialPrice) / token.initialPrice;
            token.performance[timeframe] = performance;
            token.wasChecked[timeframe] = true;
            
            // Check if this was a missed opportunity
            if (performance >= this.performanceThresholds[timeframe]) {
              await this.logMissedOpportunity(token, timeframe, performance);
            }
            
            logger.debug(`${token.tokenSymbol} ${timeframe} performance: ${(performance * 100).toFixed(2)}%`);
          } else {
            logger.warn(`Could not get current price for ${token.tokenSymbol}`);
            token.wasChecked[timeframe] = true; // Mark as checked anyway to avoid repeated attempts
          }
        } catch (error) {
          logger.error(`Error checking ${timeframe} performance for ${token.tokenSymbol}: ${error.message}`);
          token.wasChecked[timeframe] = true; // Mark as checked to avoid repeated errors
        }
      }
      
      // Save updated data
      await this.saveMemory();
      
    } catch (error) {
      logger.error(`Error checking rejected token performance: ${error.message}`);
    }
  }

  /**
   * Get the current price of a token
   * @param {string} tokenAddress - The token address
   * @returns {number|null} - The current price or null if not available
   */
  async getCurrentTokenPrice(tokenAddress) {
    try {
      // This is a simplified implementation
      // In a real implementation, you would fetch the current price from DEX or market scanner
      const tokenInfo = await marketScanner.getTokenInfo(tokenAddress);
      return tokenInfo?.price || null;
    } catch (error) {
      logger.error(`Error getting current price for ${tokenAddress}: ${error.message}`);
      return null;
    }
  }

  /**
   * Log a missed opportunity when a rejected token performs well
   * @param {Object} token - The rejected token
   * @param {string} timeframe - The timeframe ('1h', '4h', or '24h')
   * @param {number} performance - The performance (as a decimal)
   */
  async logMissedOpportunity(token, timeframe, performance) {
    try {
      const missedOpportunity = {
        tokenAddress: token.tokenAddress,
        tokenSymbol: token.tokenSymbol,
        timestamp: Date.now(),
        rejectionTimestamp: token.timestamp,
        timeframe,
        performance,
        reasons: [...token.reasons],
        scores: { ...token.scores }
      };
      
      this.missedOpportunities.push(missedOpportunity);
      
      logger.warn(`Missed opportunity: ${token.tokenSymbol} gained ${(performance * 100).toFixed(2)}% in ${timeframe}`);
      
      // Log to database for analytics
      await database.logEvent(
        'MISSED_OPPORTUNITY',
        `${token.tokenSymbol} gained ${(performance * 100).toFixed(2)}% in ${timeframe}`,
        {
          tokenAddress: token.tokenAddress,
          tokenSymbol: token.tokenSymbol,
          timeframe,
          performance,
          reasons: token.reasons,
          scores: token.scores
        }
      );
      
      // Save updated memory
      await this.saveMemory();
    } catch (error) {
      logger.error(`Error logging missed opportunity: ${error.message}`);
    }
  }

  /**
   * Apply learning from missed opportunities to adjust scoring weights
   */
  async applyLearning() {
    if (!this.initialized || this.missedOpportunities.length === 0) {
      return;
    }
    
    try {
      logger.info(`Applying learning from ${this.missedOpportunities.length} missed opportunities`);
      
      // Get current weights from token scorer
      const currentWeights = tokenScorer.getScoreWeights();
      const newWeights = { ...currentWeights };
      
      // Analyze missed opportunities to identify patterns
      const scorePatterns = this.analyzeMissedOpportunities();
      
      // Adjust weights based on patterns
      let weightsChanged = false;
      
      for (const [scoreType, pattern] of Object.entries(scorePatterns)) {
        if (pattern.count >= 3 && pattern.avgScore > 0.7) {
          // If we consistently missed tokens with high scores in a particular category,
          // increase the weight of that category
          const oldWeight = newWeights[scoreType] || 0;
          newWeights[scoreType] = oldWeight + (this.learningRate * pattern.avgPerformance);
          weightsChanged = true;
          
          logger.info(`Increasing weight for ${scoreType} from ${oldWeight.toFixed(2)} to ${newWeights[scoreType].toFixed(2)}`);
        }
      }
      
      // Normalize weights to ensure they sum to 1
      if (weightsChanged) {
        const weightSum = Object.values(newWeights).reduce((sum, weight) => sum + weight, 0);
        
        for (const scoreType in newWeights) {
          newWeights[scoreType] = newWeights[scoreType] / weightSum;
        }
        
        // Update weights in token scorer
        tokenScorer.updateScoreWeights(newWeights);
        
        logger.info('Updated token scoring weights based on reinforcement learning');
        
        // Log the weight changes
        await database.logEvent(
          'WEIGHTS_UPDATED',
          'Updated token scoring weights based on reinforcement learning',
          {
            oldWeights: currentWeights,
            newWeights
          }
        );
      } else {
        logger.info('No weight adjustments needed based on current data');
      }
    } catch (error) {
      logger.error(`Error applying learning: ${error.message}`);
    }
  }

  /**
   * Analyze missed opportunities to identify patterns
   * @returns {Object} - Patterns in the missed opportunities
   */
  analyzeMissedOpportunities() {
    const patterns = {};
    
    // Only consider recent missed opportunities (last 7 days)
    const recentCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const recentMissed = this.missedOpportunities.filter(opp => opp.timestamp >= recentCutoff);
    
    if (recentMissed.length === 0) {
      return patterns;
    }
    
    // Initialize patterns for each score type
    for (const missedOpp of recentMissed) {
      if (!missedOpp.scores) continue;
      
      for (const [scoreType, score] of Object.entries(missedOpp.scores)) {
        if (!patterns[scoreType]) {
          patterns[scoreType] = {
            count: 0,
            totalScore: 0,
            totalPerformance: 0,
            avgScore: 0,
            avgPerformance: 0
          };
        }
        
        patterns[scoreType].count++;
        patterns[scoreType].totalScore += score;
        patterns[scoreType].totalPerformance += missedOpp.performance;
      }
    }
    
    // Calculate averages
    for (const scoreType in patterns) {
      if (patterns[scoreType].count > 0) {
        patterns[scoreType].avgScore = patterns[scoreType].totalScore / patterns[scoreType].count;
        patterns[scoreType].avgPerformance = patterns[scoreType].totalPerformance / patterns[scoreType].count;
      }
    }
    
    return patterns;
  }

  /**
   * Clean up old rejected tokens to prevent memory bloat
   */
  async cleanupOldRejectedTokens() {
    try {
      const now = Date.now();
      const threeDaysAgo = now - (3 * 24 * 60 * 60 * 1000);
      
      // Keep tokens that are either recent or marked as missed opportunities
      const oldLength = this.rejectedTokens.length;
      this.rejectedTokens = this.rejectedTokens.filter(token => {
        // Keep if less than 3 days old
        if (token.timestamp >= threeDaysAgo) return true;
        
        // Keep if it was a missed opportunity
        const wasMissed = this.missedOpportunities.some(opp => opp.tokenAddress === token.tokenAddress);
        return wasMissed;
      });
      
      const removedCount = oldLength - this.rejectedTokens.length;
      
      if (removedCount > 0) {
        logger.info(`Cleaned up ${removedCount} old rejected tokens`);
        await this.saveMemory();
      }
    } catch (error) {
      logger.error(`Error cleaning up old rejected tokens: ${error.message}`);
    }
  }

  /**
   * Save the current memory to disk
   */
  async saveMemory() {
    try {
      const memory = {
        rejectedTokens: this.rejectedTokens,
        missedOpportunities: this.missedOpportunities,
        lastUpdated: Date.now()
      };
      
      await fs.writeFile(this.memoryFilePath, JSON.stringify(memory, null, 2));
    } catch (error) {
      logger.error(`Error saving reinforcement memory: ${error.message}`);
    }
  }

  /**
   * Get statistics about the reinforcement learning system
   * @returns {Object} - Statistics about missed opportunities and learning
   */
  getStatistics() {
    // Calculate statistics for visualization and reporting
    const totalRejected = this.rejectedTokens.length;
    const totalMissed = this.missedOpportunities.length;
    
    // Calculate missed opportunity rate over time (by week)
    const weeklyStats = this.calculateWeeklyStats();
    
    return {
      totalRejectedTokens: totalRejected,
      totalMissedOpportunities: totalMissed,
      missedOpportunityRate: totalRejected > 0 ? (totalMissed / totalRejected) : 0,
      weeklyStats
    };
  }

  /**
   * Calculate weekly statistics for missed opportunities
   * @returns {Array} - Weekly statistics
   */
  calculateWeeklyStats() {
    const stats = [];
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    
    // Calculate stats for the last 10 weeks
    for (let i = 0; i < 10; i++) {
      const weekStart = now - ((i + 1) * weekMs);
      const weekEnd = now - (i * weekMs);
      
      const weekRejected = this.rejectedTokens.filter(
        token => token.timestamp >= weekStart && token.timestamp < weekEnd
      ).length;
      
      const weekMissed = this.missedOpportunities.filter(
        opp => opp.timestamp >= weekStart && opp.timestamp < weekEnd
      ).length;
      
      stats.push({
        weekNumber: -i,
        startDate: new Date(weekStart).toISOString().split('T')[0],
        endDate: new Date(weekEnd).toISOString().split('T')[0],
        rejectedCount: weekRejected,
        missedCount: weekMissed,
        missedRate: weekRejected > 0 ? (weekMissed / weekRejected) : 0
      });
    }
    
    return stats.reverse(); // Return in chronological order
  }
}

module.exports = new ReinforcementLearning();