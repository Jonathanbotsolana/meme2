/**
 * Simple script to check if environment variables are loaded correctly
 */

require('dotenv').config();
const logger = require('../src/utils/logger');

console.log('Environment variables:');
console.log(`TRADING_ENABLED: ${process.env.TRADING_ENABLED}`);
console.log(`TEST_MODE: ${process.env.TEST_MODE}`);
console.log(`MONITORING_INTERVAL_MINUTES: ${process.env.MONITORING_INTERVAL_MINUTES}`);

logger.info('Environment variables loaded successfully');
logger.info(`TRADING_ENABLED: ${process.env.TRADING_ENABLED}`);
logger.info(`TEST_MODE: ${process.env.TEST_MODE}`);
logger.info(`MONITORING_INTERVAL_MINUTES: ${process.env.MONITORING_INTERVAL_MINUTES}`);