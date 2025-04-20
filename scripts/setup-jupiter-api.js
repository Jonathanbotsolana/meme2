/**
 * Guide for setting up Jupiter API key
 * Usage: node scripts/setup-jupiter-api.js
 */

console.log('=== JUPITER API KEY SETUP GUIDE ===\n');

console.log('Jupiter now offers API keys that provide higher rate limits and better performance.');
console.log('Follow these steps to get your Jupiter API key:\n');

console.log('1. Visit https://station.jup.ag/api');
console.log('2. Connect your wallet');
console.log('3. Create a new API key');
console.log('4. Copy your API key');
console.log('5. Add it to your Jupiter initialization code:\n');

console.log('   this.jupiter = await Jupiter.load({');
console.log('     connection: this.connectionManager.getConnection(),');
console.log('     cluster: \'mainnet-beta\',');
console.log('     defaultExchangeVersion: 6,');
console.log('     routeCacheDuration: 0,');
console.log('     apiKey: \'YOUR_JUPITER_API_KEY\',  // Add your API key here');
console.log('   });\n');

console.log('Benefits of using a Jupiter API key:');
console.log('- Higher rate limits (avoid 429 Too Many Requests errors)');
console.log('- Priority routing');
console.log('- Better performance and reliability');
console.log('- Access to premium features\n');

console.log('=== JUPITER API RATE LIMITING ===\n');

console.log('Jupiter API uses a token bucket rate limiting system applied per account:\n');

console.log('API Hostnames:');
console.log('- For paid tiers with API Keys: api.jup.ag');
console.log('- For free tier: lite-api.jup.ag\n');

console.log('Rate Limits by Tier:');
console.log('┌─────────┬────────────────────┬──────────────────┬────────────┐');
console.log('│ Tier    │ Requests Per Min  │ Tokens Allocated │ Per Period │');
console.log('├─────────┼────────────────────┼──────────────────┼────────────┤');
console.log('│ Free    │ 60                │ 60               │ 1 minute   │');
console.log('│ Pro I   │ 600               │ 100              │ 10 seconds │');
console.log('│ Pro II  │ 3,000             │ 500              │ 10 seconds │');
console.log('│ Pro III │ 6,000             │ 1,000            │ 10 seconds │');
console.log('│ Pro IV  │ 30,000            │ 5,000            │ 10 seconds │');
console.log('└─────────┴────────────────────┴──────────────────┴────────────┘\n');

console.log('Token Buckets:');
console.log('- Default bucket: Shared for all APIs except the Price API');
console.log('- Price API bucket: Dedicated to the Price API (except for free tier)\n');

console.log('Note: The free tier does not have a dedicated Price API bucket.\n');

console.log('Managing Rate Limits:');
console.log('- If you receive a 429 (Too Many Requests) response:');
console.log('  1. Wait for your bucket to refill');
console.log('  2. Implement exponential backoff in your retry logic');
console.log('  3. Consider upgrading to a higher tier if consistently hitting limits\n');

console.log('Caution: Excessive requests beyond your rate limit may result in');
console.log('         extended blocking even after the expected refill period.\n');

console.log('For more information, visit: https://station.jup.ag/docs/apis/overview');