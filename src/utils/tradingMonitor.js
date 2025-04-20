/**
 * Trading Monitor - Tracks and reports on trading performance
 */
const logger = require('./logger');
const riskFilter = require('../modules/riskFilter');

class TradingMonitor {
  constructor() {
    this.lastReportTime = Date.now();
    this.reportInterval = 1000 * 60 * 60; // Default: hourly reports
    this.isMonitoring = false;
  }

  // Start monitoring
  startMonitoring(reportIntervalMinutes = 60) {
    if (this.isMonitoring) {
      logger.info('Trading monitor already running');
      return;
    }

    this.reportInterval = 1000 * 60 * reportIntervalMinutes;
    this.isMonitoring = true;
    this.monitoringInterval = setInterval(() => this.generateReport(), this.reportInterval);
    
    logger.info(`Trading monitor started. Reports will be generated every ${reportIntervalMinutes} minutes`);
    
    // Generate initial report
    this.generateReport();
  }

  // Stop monitoring
  stopMonitoring() {
    if (!this.isMonitoring) {
      return;
    }

    clearInterval(this.monitoringInterval);
    this.isMonitoring = false;
    logger.info('Trading monitor stopped');
  }

  // Generate a trading report
  generateReport() {
    const stats = riskFilter.getTradingStats();
    const now = Date.now();
    const timeSinceLastReport = (now - this.lastReportTime) / (1000 * 60);
    
    logger.info('=== TRADING PERFORMANCE REPORT ===');
    logger.info(`Report period: ${timeSinceLastReport.toFixed(0)} minutes`);
    logger.info(`Trading enabled: ${riskFilter.isTradingEnabled()}`);
    logger.info(`Test mode: ${riskFilter.isTestMode()}`);
    logger.info(`Tokens passed evaluation: ${stats.passedEvaluation}`);
    logger.info(`Successful trades: ${stats.successfulTrades}`);
    logger.info(`Failed trades: ${stats.failedTrades}`);
    logger.info(`Success rate: ${stats.successRate}`);
    
    // Report on individual token performance
    if (stats.tokenPerformance && Object.keys(stats.tokenPerformance).length > 0) {
      logger.info('--- Token Performance ---');
      
      Object.entries(stats.tokenPerformance).forEach(([tokenAddress, performance]) => {
        const successRate = performance.passedEvaluation > 0 
          ? (performance.successfulTrades / performance.passedEvaluation) * 100 
          : 0;
          
        logger.info(`Token: ${tokenAddress}`);
        logger.info(`  Success rate: ${successRate.toFixed(2)}%`);
        logger.info(`  Trades: ${performance.successfulTrades} successful, ${performance.failedTrades} failed`);
        
        if (performance.profitLoss !== 0) {
          logger.info(`  P/L: ${performance.profitLoss > 0 ? '+' : ''}${performance.profitLoss.toFixed(4)} SOL`);
        }
      });
    }
    
    logger.info('=== END OF REPORT ===');
    
    this.lastReportTime = now;
    return stats;
  }

  // Record a successful trade
  recordSuccessfulTrade(tokenAddress, profitLoss = 0) {
    return riskFilter.recordSuccessfulTrade(tokenAddress, profitLoss);
  }

  // Record a failed trade
  recordFailedTrade(tokenAddress, reason = '') {
    return riskFilter.recordFailedTrade(tokenAddress, reason);
  }
}

module.exports = new TradingMonitor();