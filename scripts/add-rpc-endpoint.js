/**
 * Add RPC Endpoint Script
 * 
 * This script helps you add a new RPC endpoint to the configuration.
 * It validates the endpoint before adding it and updates the config file.
 */

const { Connection } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const configPath = path.join(__dirname, '../config/config.js');

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

/**
 * Validate an RPC endpoint
 * @param {string} endpoint - The RPC endpoint URL
 * @returns {Promise<{success: boolean, latency: number, error: string|null}>}
 */
async function validateEndpoint(endpoint) {
  console.log(`Validating endpoint: ${endpoint}...`);
  const startTime = Date.now();
  try {
    const connection = new Connection(endpoint, 'confirmed');
    await connection.getRecentBlockhash();
    const latency = Date.now() - startTime;
    console.log(`✅ Endpoint is valid! Latency: ${latency}ms`);
    return { success: true, latency, error: null };
  } catch (error) {
    const latency = Date.now() - startTime;
    console.log(`❌ Endpoint validation failed: ${error.message}`);
    return { success: false, latency, error: error.message };
  }
}

/**
 * Add an endpoint to the configuration
 * @param {string} endpoint - The RPC endpoint URL
 * @param {number} tier - The tier level (1-3)
 */
function addEndpointToConfig(endpoint, tier) {
  try {
    // Read the current config file
    let configContent = fs.readFileSync(configPath, 'utf8');
    
    // Check if the endpoint already exists
    if (configContent.includes(`'${endpoint}'`)) {
      console.log('⚠️ This endpoint already exists in the configuration.');
      return false;
    }
    
    // Add to rpcEndpoints array
    const endpointsMatch = configContent.match(/rpcEndpoints:\s*\[([\s\S]*?)\]/m);
    if (!endpointsMatch) {
      console.log('❌ Could not find rpcEndpoints array in config file.');
      return false;
    }
    
    const endpointsContent = endpointsMatch[1];
    const newEndpointsContent = endpointsContent + `      '${endpoint}',\n`;
    configContent = configContent.replace(endpointsContent, newEndpointsContent);
    
    // Add to rpcEndpointTiers object
    const tiersMatch = configContent.match(/rpcEndpointTiers:\s*\{([\s\S]*?)\}/m);
    if (!tiersMatch) {
      console.log('❌ Could not find rpcEndpointTiers object in config file.');
      return false;
    }
    
    const tiersContent = tiersMatch[1];
    let tierDescription = '';
    if (tier === 3) tierDescription = 'Premium endpoint';
    else if (tier === 2) tierDescription = 'Reliable but rate-limited';
    else tierDescription = 'Public endpoint, less reliable';
    
    const newTiersContent = tiersContent + `      '${endpoint}': ${tier}, // ${tierDescription}\n`;
    configContent = configContent.replace(tiersContent, newTiersContent);
    
    // Write the updated config back to the file
    fs.writeFileSync(configPath, configContent, 'utf8');
    console.log(`✅ Added endpoint to configuration with tier ${tier}.`);
    return true;
  } catch (error) {
    console.log(`❌ Error updating config file: ${error.message}`);
    return false;
  }
}

/**
 * Main function to add a new endpoint
 */
async function addNewEndpoint() {
  console.log('=== Add New RPC Endpoint ===\n');
  
  rl.question('Enter the RPC endpoint URL: ', async (endpoint) => {
    if (!endpoint) {
      console.log('❌ Endpoint URL is required.');
      rl.close();
      return;
    }
    
    // Validate the endpoint
    const validation = await validateEndpoint(endpoint);
    
    if (!validation.success) {
      rl.question('Endpoint validation failed. Do you still want to add it? (y/n): ', (answer) => {
        if (answer.toLowerCase() !== 'y') {
          console.log('Operation cancelled.');
          rl.close();
          return;
        }
        promptForTier(endpoint);
      });
    } else {
      promptForTier(endpoint);
    }
  });
}

/**
 * Prompt for tier selection
 * @param {string} endpoint - The RPC endpoint URL
 */
function promptForTier(endpoint) {
  rl.question('Select tier (1=Public, 2=Reliable, 3=Premium): ', (tierStr) => {
    const tier = parseInt(tierStr);
    
    if (isNaN(tier) || tier < 1 || tier > 3) {
      console.log('❌ Invalid tier. Please enter 1, 2, or 3.');
      promptForTier(endpoint);
      return;
    }
    
    // Add to config
    const added = addEndpointToConfig(endpoint, tier);
    
    if (added) {
      console.log('\n✅ Endpoint added successfully!');
      console.log('Restart your bot for the changes to take effect.');
    }
    
    rl.close();
  });
}

// Run the script
addNewEndpoint();