/**
 * Script to check the health of RPC endpoints
 * Usage: node scripts/check-rpc-health.js
 */

const { Connection } = require('@solana/web3.js');

// RPC endpoints to check
const RPC_ENDPOINTS = [
  'https://mainnet.helius-rpc.com/?api-key=f7e0528e-7e2d-404f-8ae7-e774405c422f',
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
  'https://solana-api.projectserum.com',
  'https://solana.api.mngo.cloud',
  'https://hidden-indulgent-card.solana-mainnet.quiknode.pro/88200bf9df13e5a27afeadbd45afa50be60273b9/',
  // Add any other endpoints you want to check
];

// Health check function
async function checkEndpointHealth(endpoint) {
  console.log(`Testing endpoint: ${endpoint}`);
  const startTime = Date.now();
  
  try {
    const connection = new Connection(endpoint, 'confirmed');
    
    // Test 1: Get recent blockhash
    console.log('  Testing getRecentBlockhash...');
    const blockhashResult = await connection.getRecentBlockhash('finalized');
    console.log(`  ✅ Got blockhash: ${blockhashResult.blockhash.slice(0, 10)}...`);
    
    // Test 2: Get slot
    console.log('  Testing getSlot...');
    const slot = await connection.getSlot();
    console.log(`  ✅ Current slot: ${slot}`);
    
    // Test 3: Get block height
    console.log('  Testing getBlockHeight...');
    const blockHeight = await connection.getBlockHeight();
    console.log(`  ✅ Current block height: ${blockHeight}`);
    
    // Test 4: Get version
    console.log('  Testing getVersion...');
    const version = await connection.getVersion();
    console.log(`  ✅ Node version: ${version['solana-core']}`);
    
    // Test 5: Get token supply
    console.log('  Testing getTokenSupply for SOL...');
    const supply = await connection.getSupply();
    console.log(`  ✅ SOL total supply: ${supply.value.total / 1e9} SOL`);
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    console.log(`✅ ENDPOINT HEALTHY: ${endpoint}`);
    console.log(`   Response time: ${duration}ms`);
    console.log('\n');
    
    return {
      endpoint,
      healthy: true,
      responseTime: duration,
      error: null
    };
  } catch (error) {
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    console.log(`❌ ENDPOINT FAILED: ${endpoint}`);
    console.log(`   Error: ${error.message}`);
    console.log(`   Response time: ${duration}ms`);
    console.log('\n');
    
    return {
      endpoint,
      healthy: false,
      responseTime: duration,
      error: error.message
    };
  }
}

// Main function
async function main() {
  console.log('=== RPC ENDPOINT HEALTH CHECK ===\n');
  console.log(`Testing ${RPC_ENDPOINTS.length} endpoints...\n`);
  
  const results = [];
  
  for (const endpoint of RPC_ENDPOINTS) {
    const result = await checkEndpointHealth(endpoint);
    results.push(result);
  }
  
  // Summary
  console.log('=== HEALTH CHECK SUMMARY ===');
  
  const healthyEndpoints = results.filter(r => r.healthy);
  console.log(`\nHealthy endpoints: ${healthyEndpoints.length}/${results.length}`);
  
  if (healthyEndpoints.length > 0) {
    console.log('\nHealthy endpoints by response time:');
    healthyEndpoints
      .sort((a, b) => a.responseTime - b.responseTime)
      .forEach((result, index) => {
        console.log(`${index + 1}. ${result.endpoint} (${result.responseTime}ms)`);
      });
  }
  
  const unhealthyEndpoints = results.filter(r => !r.healthy);
  if (unhealthyEndpoints.length > 0) {
    console.log('\nUnhealthy endpoints:');
    unhealthyEndpoints.forEach((result, index) => {
      console.log(`${index + 1}. ${result.endpoint} - Error: ${result.error}`);
    });
  }
  
  // Recommendations
  console.log('\n=== RECOMMENDATIONS ===');
  if (healthyEndpoints.length === 0) {
    console.log('❌ CRITICAL: All endpoints are failing! Add new RPC endpoints immediately.');
  } else if (healthyEndpoints.length < 3) {
    console.log('⚠️ WARNING: Less than 3 healthy endpoints. Consider adding more reliable endpoints.');
  } else {
    console.log('✅ You have multiple healthy endpoints. For best performance, prioritize the fastest ones.');
  }
  
  if (results.some(r => r.error && r.error.includes('429'))) {
    console.log('⚠️ Some endpoints are rate limiting your requests. Consider:');
    console.log('   1. Adding premium RPC endpoints with higher rate limits');
    console.log('   2. Implementing better request batching and rate limiting');
    console.log('   3. Distributing requests more evenly across endpoints');
  }
}

// Run the script
main().catch(console.error);