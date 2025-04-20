const logger = require('../utils/logger');
const database = require('../utils/database');
const swapExecutor = require('./swapExecutor');

class PnLTracker {
  constructor() {
    this.activeTrades = new Map();
    this.tradingStats = {
      totalTrades: 0,
      profitableTrades: 0,
      unprofitableTrades: 0,
      totalProfitLoss: 0,
      winRate: 0,
      averageProfitLoss: 0,
    };
  }

  async initialize() {
    try {
      // Load active trades from database
      const activeTrades = await database.getActiveTrades();
      
      for (const trade of activeTrades) {
        this.activeTrades.set(trade.token_address, {
          id: trade.id,
          tokenAddress: trade.token_address,
          tokenSymbol: trade.token_symbol,
          buyPrice: trade.buy_price,
          buyAmount: trade.buy_amount,
          buyTimestamp: trade.buy_timestamp,
          currentPrice: trade.buy_price, // Will be updated
          currentValue: trade.buy_price * trade.buy_amount,
          profitLossPercent: 0, // Will be updated
        });
      }
      
      logger.info(`Loaded ${this.activeTrades.size} active trades from database`);
      
      // Load trading stats
      await this.updateTradingStats();
    } catch (error) {
      logger.error(`Error initializing PnL tracker: ${error.message}`);
    }
  }

  async trackNewTrade(tradeData) {
    try {
      const { tokenAddress, tokenSymbol, buyPrice, buyAmount, buyTimestamp } = tradeData;
      
      this.activeTrades.set(tokenAddress, {
        id: tradeData.id,
        tokenAddress,
        tokenSymbol,
        buyPrice,
        buyAmount,
        buyTimestamp,
        currentPrice: buyPrice,
        currentValue: buyPrice * buyAmount,
        profitLossPercent: 0,
      });
      
      logger.info(`Started tracking new trade: ${tokenSymbol} (${tokenAddress})`);
      await this.updateTradingStats();
    } catch (error) {
      logger.error(`Error tracking new trade: ${error.message}`);
    }
  }

  async updateTradePrice(tokenAddress, currentPrice) {
    try {
      if (!this.activeTrades.has(tokenAddress)) {
        return false;
      }
      
      const trade = this.activeTrades.get(tokenAddress);
      trade.currentPrice = currentPrice;
      trade.currentValue = currentPrice * trade.buyAmount;
      trade.profitLossPercent = ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100;
      
      logger.debug(`Updated price for ${trade.tokenSymbol}: $${currentPrice.toFixed(8)}, P/L: ${trade.profitLossPercent.toFixed(2)}%`);
      return true;
    } catch (error) {
      logger.error(`Error updating trade price: ${error.message}`);
      return false;
    }
  }

  async closeTrade(tokenAddress, sellPrice, sellAmount) {
    try {
      if (!this.activeTrades.has(tokenAddress)) {
        logger.warn(`Attempted to close non-existent trade: ${tokenAddress}`);
        return false;
      }
      
      const trade = this.activeTrades.get(tokenAddress);
      const profitLoss = (sellPrice * sellAmount) - (trade.buyPrice * trade.buyAmount);
      const profitLossPercent = (profitLoss / (trade.buyPrice * trade.buyAmount)) * 100;
      
      logger.info(`Closing trade: ${trade.tokenSymbol} (${tokenAddress}), P/L: ${profitLossPercent.toFixed(2)}%`);
      
      // Remove from active trades
      this.activeTrades.delete(tokenAddress);
      
      // Update trading stats
      await this.updateTradingStats();
      
      // Decrement active transactions counter in the main bot instance
      const bot = require('../index').bot;
      if (bot && typeof bot.activeTransactions === 'number') {
        bot.activeTransactions = Math.max(0, bot.activeTransactions - 1);
        logger.info(`Active transactions: ${bot.activeTransactions}/${bot.maxConcurrentTransactions}`);
      }
      
      return {
        tokenAddress,
        tokenSymbol: trade.tokenSymbol,
        buyPrice: trade.buyPrice,
        buyAmount: trade.buyAmount,
        sellPrice,
        sellAmount,
        profitLoss,
        profitLossPercent,
      };
    } catch (error) {
      logger.error(`Error closing trade: ${error.message}`);
      return false;
    }
  }

  async checkTakeProfitStopLoss() {
    try {
      const config = require('../../config/config');
      const tpPercentage = config.trading.tpPercentage;
      const slPercentage = config.trading.slPercentage;
      
      const tradesToClose = [];
      
      for (const [tokenAddress, trade] of this.activeTrades.entries()) {
        // Skip if trade is too new (less than 1 minute old)
        const tradeAgeMs = Date.now() - trade.buyTimestamp;
        if (tradeAgeMs < 60000) {
          continue;
        }
        
        // Check if TP or SL is hit
        if (trade.profitLossPercent >= tpPercentage) {
          logger.info(`Take profit hit for ${trade.tokenSymbol}: ${trade.profitLossPercent.toFixed(2)}%`);
          tradesToClose.push({
            tokenAddress,
            reason: 'TP',
            profitLossPercent: trade.profitLossPercent,
          });
        } else if (trade.profitLossPercent <= -slPercentage) {
          logger.info(`Stop loss hit for ${trade.tokenSymbol}: ${trade.profitLossPercent.toFixed(2)}%`);
          tradesToClose.push({
            tokenAddress,
            reason: 'SL',
            profitLossPercent: trade.profitLossPercent,
          });
        }
      }
      
      // Execute sells for trades that hit TP/SL
      for (const tradeToClose of tradesToClose) {
        try {
          const trade = this.activeTrades.get(tradeToClose.tokenAddress);
          
          // Get token balance
          const tokenBalance = await swapExecutor.getTokenBalance(tradeToClose.tokenAddress);
          
          // Execute sell
          const sellResult = await swapExecutor.executeSell(
            tradeToClose.tokenAddress,
            tokenBalance
          );
          
          if (sellResult.success) {
            logger.info(`Successfully closed trade (${tradeToClose.reason}): ${trade.tokenSymbol}, P/L: ${tradeToClose.profitLossPercent.toFixed(2)}%`);
            
            // Close trade in tracker
            await this.closeTrade(
              tradeToClose.tokenAddress,
              sellResult.outputAmountUsd / sellResult.inputAmount,
              sellResult.inputAmount
            );
          } else {
            logger.error(`Failed to execute sell for ${trade.tokenSymbol}: ${sellResult.error}`);
          }
        } catch (error) {
          logger.error(`Error closing trade for TP/SL: ${error.message}`);
        }
      }
      
      return tradesToClose.length;
    } catch (error) {
      logger.error(`Error checking take profit/stop loss: ${error.message}`);
      return 0;
    }
  }

  async updateTradingStats() {
    try {
      const stats = await database.getTradingStats();
      
      this.tradingStats = {
        totalTrades: stats.total_trades || 0,
        activeTrades: stats.active_trades || 0,
        closedTrades: stats.closed_trades || 0,
        profitableTrades: stats.profitable_trades || 0,
        unprofitableTrades: stats.unprofitable_trades || 0,
        totalProfitLoss: stats.total_profit_loss || 0,
        winRate: stats.closed_trades > 0 ? (stats.profitable_trades / stats.closed_trades) * 100 : 0,
        averageProfitLoss: stats.closed_trades > 0 ? stats.avg_profit_loss_percentage || 0 : 0,
      };
      
      logger.debug(`Updated trading stats: ${JSON.stringify(this.tradingStats)}`);
      return this.tradingStats;
    } catch (error) {
      logger.error(`Error updating trading stats: ${error.message}`);
      return this.tradingStats;
    }
  }

  getActiveTrades() {
    return Array.from(this.activeTrades.values());
  }

  getTradingStats() {
    return this.tradingStats;
  }

  async getTradeHistory(limit = 20) {
    try {
      // This is a placeholder for getting trade history from database
      // In a real implementation, you would query the database for closed trades
      
      // For now, we'll return an empty array
      return [];
    } catch (error) {
      logger.error(`Error getting trade history: ${error.message}`);
      return [];
    }
  }
}

module.exports = new PnLTracker();