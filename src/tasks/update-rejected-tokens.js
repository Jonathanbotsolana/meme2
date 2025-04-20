/**
 * Scheduled task to update prices for rejected tokens
 * This should be run periodically (e.g., every 5 minutes) to track price movements
 */

const database = require('../utils/database');
const logger = require('../utils/logger');

async function updateRejectedTokens() {
  try {
    logger.info('Starting scheduled update of rejected token prices');
    
    // Update prices for all tracked tokens
    const updatedCount = await database.updateRejectedTokenPrices();
    
    logger.info(`Updated prices for ${updatedCount} rejected tokens`);
    
    // Get current statistics
    const stats = await database.getReinforcementLearningStats();
    
    logger.info(`Reinforcement Learning Stats: ${stats.missedOpportunities} missed opportunities, ${stats.accuracy.toFixed(2)}% accuracy`);
    
    return updatedCount;
  } catch (error) {
    logger.error(`Error updating rejected token prices: ${error.message}`);
    throw error;
  }
}

// Export the function for use in scheduled tasks
module.exports = updateRejectedTokens;

// If this script is run directly, execute the update
if (require.main === module) {
  updateRejectedTokens()
    .then(() => {
      logger.info('Rejected token update completed');
      process.exit(0);
    })
    .catch(error => {
      logger.error(`Rejected token update failed: ${error.message}`);
      process.exit(1);
    });
}