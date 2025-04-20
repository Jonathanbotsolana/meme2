const { Connection, PublicKey } = require('@solana/web3.js');
const config = require('../config/config');

async function checkRpcHealth() {
  console.log('=== RPC HEALTH CHECK ===');
  console.log(`Testing ${config.solana.rpcEndpoints.length} RPC endpoints...\n`);
  
  const results = [];
  
  for (const rpcUrl of config.solana.rpcEndpoints) {
    try {
      console.log(`Testing: ${rpcUrl}`);
      const connection = new Connection(rpcUrl, 'confirmed');
      
      // Test 1: Get latest blockhash
      console.log('  - Testing getLatestBlockhash...');
      const startBlockhash = Date.now();
      const blockhash = await connection.getLatestBlockhash();
      const blockhashTime = Date.now() - startBlockhash;
      console.log(`    \u2713 Success (${blockhashTime}ms)`);
      
      // Test 2: Get token accounts
      console.log('  - Testing getTokenAccountsByOwner...');
      const startTokens = Date.now();
      const testWalletAddress = new PublicKey('DWuoQV3NJ2Nwm7ZXpBcbZhcHHzWZ5x2PKCuHJwEpDRZh'); // Example wallet
      await connection.getTokenAccountsByOwner(
        testWalletAddress,
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') },
        'confirmed'
      );
      const tokensTime = Date.now() - startTokens;
      console.log(`    \u2713 Success (${tokensTime}ms)`);
      
      // Test 3: Get recent performance samples
      console.log('  - Testing getRecentPerformanceSamples...');
      const startPerf = Date.now();
      const perfSamples = await connection.getRecentPerformanceSamples(5);
      const perfTime = Date.now() - startPerf;
      console.log(`    \u2713 Success (${perfTime}ms)`);
      
      // Calculate TPS from performance samples
      const tps = perfSamples.reduce((sum, sample) => sum + sample.numTransactions / sample.samplePeriodSecs, 0) / perfSamples.length;
      
      // Test 4: Get account info
      console.log('  - Testing getAccountInfo...');
      const startAccount = Date.now();
      const jupiterProgramId = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'); // Jupiter program
      await connection.getAccountInfo(jupiterProgramId);
      const accountTime = Date.now() - startAccount;
      console.log(`    \u2713 Success (${accountTime}ms)`);
      
      // Calculate overall score (lower is better)
      const totalTime = blockhashTime + tokensTime + perfTime + accountTime;
      const avgTime = totalTime / 4;
      
      results.push({
        rpcUrl,
        status: 'Healthy',
        avgResponseTime: avgTime,
        tps,
        tier: config.solana.rpcEndpointTiers[rpcUrl] || 0,
        tests: {
          blockhash: blockhashTime,
          tokens: tokensTime,
          performance: perfTime,
          account: accountTime
        }
      });
      
      console.log(`  \u2713 Overall: Healthy (Avg: ${avgTime.toFixed(2)}ms, TPS: ${tps.toFixed(2)})\n`);
    } catch (error) {
      console.log(`  \u2717 Failed: ${error.message}\n`);
      
      results.push({
        rpcUrl,
        status: 'Unhealthy',
        error: error.message,
        tier: config.solana.rpcEndpointTiers[rpcUrl] || 0
      });
    }
  }
  
  // Sort by status (healthy first), then by tier (highest first), then by response time (lowest first)
  results.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'Healthy' ? -1 : 1;
    if (a.tier !== b.tier) return b.tier - a.tier;
    if (a.avgResponseTime && b.avgResponseTime) return a.avgResponseTime - b.avgResponseTime;
    return 0;
  });
  
  console.log('=== SUMMARY ===');
  console.log(`Total endpoints tested: ${results.length}`);
  console.log(`Healthy endpoints: ${results.filter(r => r.status === 'Healthy').length}`);
  console.log(`Unhealthy endpoints: ${results.filter(r => r.status === 'Unhealthy').length}\n`);
  
  console.log('Top 5 recommended endpoints:');
  results.slice(0, 5).forEach((result, index) => {
    if (result.status === 'Healthy') {
      console.log(`${index + 1}. ${result.rpcUrl} (Tier ${result.tier}, Avg: ${result.avgResponseTime.toFixed(2)}ms, TPS: ${result.tps.toFixed(2)})`);
    } else {
      console.log(`${index + 1}. ${result.rpcUrl} (Tier ${result.tier}, Unhealthy: ${result.error})`);
    }
  });
  
  // Provide configuration recommendation
  console.log('\n=== RECOMMENDED CONFIGURATION ===');
  console.log('Add these lines to your .env file:\n');
  
  const healthyEndpoints = results.filter(r => r.status === 'Healthy');
  if (healthyEndpoints.length > 0) {
    console.log(`SOLANA_RPC_URL=${healthyEndpoints[0].rpcUrl}`);
    
    console.log('\nOr update your config.js with this prioritized list:\n');
    console.log('rpcEndpoints: [');
    healthyEndpoints.slice(0, 8).forEach(endpoint => {
      console.log(`  '${endpoint.rpcUrl}', // Tier ${endpoint.tier}, Avg: ${endpoint.avgResponseTime.toFixed(2)}ms`);
    });
    console.log('  // ...other endpoints');
    console.log('],');
  } else {
    console.log('No healthy endpoints found. Please check your network connection or try again later.');
  }
}

checkRpcHealth().catch(console.error);