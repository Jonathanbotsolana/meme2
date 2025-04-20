#!/usr/bin/env node

/**
 * Script to test RPC endpoints and find the most reliable ones
 */

const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config = require('../config/config');

// List of endpoints to test
const endpoints = config.solana.rpcEndpoints;

// Test parameters
const NUM_TESTS = 3;
const TEST_TIMEOUT = 10000; // 10 seconds

// Test functions
async function testGetBalance(connection) {
  const publicKey = new PublicKey('83astBRguLMdt2h5U1Tpdq5tjFoJ6noeGwaY3mDLVcri');
  return await connection.getBalance(publicKey);
}

async function testGetRecentBlockhash(connection) {
  return await connection.getLatestBlockhash();
}

async function testGetTokenAccountsByOwner(connection) {
  const publicKey = new PublicKey('83astBRguLMdt2h5U1Tpdq5tjFoJ6noeGwaY3mDLVcri');
  return await connection.getTokenAccountsByOwner(
    publicKey,
    { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
  );
}

// Run tests for an endpoint
async function testEndpoint(endpoint) {
  console.log(`\nTesting endpoint: ${endpoint}`);
  
  const connection = new Connection(endpoint, { commitment: 'confirmed', timeout: TEST_TIMEOUT });
  const results = {
    endpoint,
    success: 0,
    failure: 0,
    latencies: [],
    errors: []
  };

  const tests = [
    { name: 'getBalance', fn: () => testGetBalance(connection) },
    { name: 'getRecentBlockhash', fn: () => testGetRecentBlockhash(connection) },
    { name: 'getTokenAccountsByOwner', fn: () => testGetTokenAccountsByOwner(connection) }
  ];

  for (let i = 0; i < NUM_TESTS; i++) {
    for (const test of tests) {
      try {
        const start = Date.now();
        await test.fn();
        const latency = Date.now() - start;
        
        results.success++;
        results.latencies.push(latency);
        console.log(`  ✅ ${test.name} - ${latency}ms`);
      } catch (error) {
        results.failure++;
        results.errors.push(`${test.name}: ${error.message}`);
        console.log(`  ❌ ${test.name} - ${error.message}`);
      }
    }
  }

  // Calculate average latency
  const avgLatency = results.latencies.length > 0 
    ? Math.round(results.latencies.reduce((a, b) => a + b, 0) / results.latencies.length) 
    : 'N/A';
  
  // Calculate success rate
  const totalTests = results.success + results.failure;
  const successRate = totalTests > 0 ? (results.success / totalTests * 100).toFixed(1) : 0;

  console.log(`  Summary: ${successRate}% success rate, avg latency: ${avgLatency}ms`);
  
  return {
    ...results,
    avgLatency,
    successRate: parseFloat(successRate)
  };
}

// Main function
async function main() {
  console.log('Testing Solana RPC endpoints...');
  console.log(`Running ${NUM_TESTS} iterations of 3 tests for each endpoint`);
  
  const results = [];
  
  for (const endpoint of endpoints) {
    try {
      const result = await testEndpoint(endpoint);
      results.push(result);
    } catch (error) {
      console.error(`Error testing ${endpoint}: ${error.message}`);
    }
  }
  
  // Sort by success rate (descending) and then by latency (ascending)
  results.sort((a, b) => {
    if (b.successRate !== a.successRate) {
      return b.successRate - a.successRate;
    }
    return a.avgLatency - b.avgLatency;
  });
  
  console.log('\n=== RESULTS (BEST TO WORST) ===');
  results.forEach((result, index) => {
    const tier = config.solana.rpcEndpointTiers[result.endpoint] || 'unknown';
    console.log(`${index + 1}. ${result.endpoint}`);
    console.log(`   Tier: ${tier}, Success Rate: ${result.successRate}%, Avg Latency: ${result.avgLatency}ms`);
    if (result.errors.length > 0) {
      console.log(`   Sample Errors: ${result.errors.slice(0, 2).join(', ')}`);
    }
  });
  
  console.log('\n=== RECOMMENDED CONFIGURATION ===');
  console.log('Add these endpoints to your config.js file in this order:');
  
  const recommended = results
    .filter(r => r.successRate > 80) // Only include endpoints with >80% success rate
    .slice(0, 8); // Take top 8
    
  recommended.forEach((result, index) => {
    console.log(`${index + 1}. '${result.endpoint}', // Success: ${result.successRate}%, Latency: ${result.avgLatency}ms`);
  });
}

// Run the main function
main().catch(console.error);