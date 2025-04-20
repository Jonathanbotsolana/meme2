/**
 * Script to update Jupiter API endpoints
 * 
 * This script updates the Jupiter API endpoints in the codebase to use the new hostnames:
 * - api.jup.ag for paid users with API key
 * - lite-api.jup.ag for free usage
 */

const fs = require('fs');
const path = require('path');

// Files to update
const filesToUpdate = [
  path.join(__dirname, '../src/modules/swapExecutor.js'),
  path.join(__dirname, '../scripts/jupiter-rate-limiter.js')
];

// Function to update a file
async function updateFile(filePath) {
  console.log(`Updating ${filePath}...`);
  
  try {
    // Read the file
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Update Jupiter API endpoints
    // For jupiter-rate-limiter.js
    if (filePath.includes('jupiter-rate-limiter.js')) {
      // Update free tier hostname
      content = content.replace(
        /free: \{[\s\S]*?hostname: ['"](.*?)['"]\s*\}/g,
        (match) => match.replace(/hostname: ['"](.*?)['"]/, 'hostname: \'lite-api.jup.ag\' // Free tier uses lite-api.jup.ag')
      );
      
      // Update paid tier hostnames
      content = content.replace(
        /pro[IVX]+: \{[\s\S]*?hostname: ['"](.*?)['"]\s*\}/g,
        (match) => match.replace(/hostname: ['"](.*?)['"]/, 'hostname: \'api.jup.ag\' // Paid tiers use api.jup.ag')
      );
    }
    
    // For swapExecutor.js
    if (filePath.includes('swapExecutor.js')) {
      // Update API base URL determination
      content = content.replace(
        /const apiBaseUrl = this\.jupiterRateLimiter\.config\.apiKey \? \s*'https:\/\/api\.jup\.ag' : 'https:\/\/lite-api\.jup\.ag';/g,
        "const apiBaseUrl = this.jupiterRateLimiter.config.apiKey ? \n        'https://api.jup.ag' : 'https://lite-api.jup.ag'; // Use lite-api.jup.ag for free tier, api.jup.ag for paid tiers"
      );
    }
    
    // Write the updated content back to the file
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✅ Updated ${filePath}`);
    
    return true;
  } catch (error) {
    console.error(`❌ Error updating ${filePath}:`, error.message);
    return false;
  }
}

// Main function
async function main() {
  console.log('Updating Jupiter API endpoints...');
  
  let successCount = 0;
  
  for (const filePath of filesToUpdate) {
    const success = await updateFile(filePath);
    if (success) successCount++;
  }
  
  console.log(`\nUpdate complete: ${successCount}/${filesToUpdate.length} files updated successfully.`);
  console.log('\nReminder: Jupiter API changes require:');
  console.log('- Free users must migrate to lite-api.jup.ag by May 1, 2025');
  console.log('- Paid users with API keys will continue using api.jup.ag');
}

// Run the script
main().catch(console.error);