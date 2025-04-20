const logger = require('./logger');
const rpcManager = require('./rpcManager');

class RpcHealthMonitor {
  constructor() {
    this.checkInterval = 2 * 60 * 1000; // 2 minutes (reduced from 3)
    this.monitorInterval = null;
    this.isRunning = false;
    this.consecutiveFailures = 0;
    this.lastSuccessfulCheck = Date.now();
  }

  start() {
    if (this.isRunning) return;
    
    logger.info('Starting RPC health monitor');
    this.isRunning = true;
    
    // Run an initial health check
    this.checkHealth();
    
    // Set up periodic health checks
    this.monitorInterval = setInterval(() => this.checkHealth(), this.checkInterval);
  }

  stop() {
    if (!this.isRunning) return;
    
    logger.info('Stopping RPC health monitor');
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    
    this.isRunning = false;
  }

  async checkHealth() {
    try {
      logger.info('Running scheduled RPC health check');
      logger.info('Performing health check on all RPC endpoints');
      const results = await rpcManager.checkAllEndpointsHealth();
      
      // Count healthy endpoints
      const healthyCount = Object.values(results).filter(Boolean).length;
      const totalCount = Object.keys(results).length;
      
      logger.info(`RPC health check complete: ${healthyCount}/${totalCount} endpoints healthy`);
      
      // Get detailed metrics
      const metrics = rpcManager.getEndpointMetrics();
      
      // Log the current endpoint and its metrics
      const currentEndpoint = rpcManager.getCurrentEndpoint();
      const currentMetrics = metrics[currentEndpoint] || {};
      
      logger.info(`Current endpoint: ${currentEndpoint} (Tier: ${currentMetrics.tier}, Success rate: ${currentMetrics.successRate}%, Avg latency: ${currentMetrics.avgLatency}ms)`);
      
      // If the current endpoint is healthy, reset consecutive failures
      if (results[currentEndpoint]) {
        this.consecutiveFailures = 0;
        this.lastSuccessfulCheck = Date.now();
      } else {
        // If current endpoint is unhealthy, increment failures and force rotation
        this.consecutiveFailures++;
        logger.warn(`Current endpoint ${currentEndpoint} is unhealthy. Consecutive failures: ${this.consecutiveFailures}`);
        
        // Force rotation to a healthy endpoint if available
        if (healthyCount > 0) {
          const oldEndpoint = rpcManager.getCurrentEndpoint();
          const newEndpoint = rpcManager.rotateEndpoint();
          logger.info(`Rotated from unhealthy endpoint ${oldEndpoint} to ${newEndpoint}`);
        }
        
        // If we have multiple consecutive failures, reduce check interval temporarily
        if (this.consecutiveFailures >= 3) {
          // Reset the monitor with a shorter interval
          this.stop();
          this.checkInterval = 30 * 1000; // 30 seconds
          this.start();
          logger.warn(`Multiple consecutive RPC failures detected. Increasing check frequency to 30 seconds.`);
        }
      }
      
      // If it's been too long since a successful check, try resetting all connections
      const timeSinceLastSuccess = Date.now() - this.lastSuccessfulCheck;
      if (timeSinceLastSuccess > 10 * 60 * 1000) { // 10 minutes
        logger.warn(`No successful RPC health check in ${Math.round(timeSinceLastSuccess/1000/60)} minutes. Resetting all connections.`);
        await rpcManager.resetConnections();
        this.lastSuccessfulCheck = Date.now(); // Reset the timer
      }
      
      return results;
    } catch (error) {
      logger.error(`Error during RPC health check: ${error.message}`);
      this.consecutiveFailures++;
      return false;
    }
  }
}

module.exports = new RpcHealthMonitor();