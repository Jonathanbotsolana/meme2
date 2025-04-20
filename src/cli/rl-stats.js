#!/usr/bin/env node

/**
 * CLI tool to display reinforcement learning statistics
 */

const database = require('../utils/database');
const logger = require('../utils/logger');

// Process command line arguments
const args = process.argv.slice(2);
const showHelp = args.includes('--help') || args.includes('-h');
const updatePrices = args.includes('--update') || args.includes('-u');
const resetWeights = args.includes('--reset') || args.includes('-r');

if (showHelp) {
  console.log(`
Reinforcement Learning Statistics CLI

Usage:
  node rl-stats.js [options]

Options:
  -h, --help     Show this help message
  -u, --update   Update prices for tracked tokens before showing stats
  -r, --reset    Reset weights to default values
`);
  process.exit(0);
}

async function main() {
  try {
    // Reset weights if requested
    if (resetWeights) {
      console.log('Resetting weights to default values...');
      await database.initializeDefaultWeights();
      console.log('Weights reset successfully.');
    }
    
    // Update prices if requested
    if (updatePrices) {
      console.log('Updating prices for tracked tokens...');
      const updatedCount = await database.updateRejectedTokenPrices();
      console.log(`Updated ${updatedCount} tokens.`);
    }
    
    // Get and display the report
    const report = await database.getReinforcementLearningReport();
    console.log(report);
    
    // Close the database connection
    await database.close();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Run the main function
main();