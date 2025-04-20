/**
 * Test script to verify Jupiter API endpoints
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Check if an API key is provided
let apiKey = null;
try {
  const configPath = path.join(__dirname, '../config/config.js');
  if (fs.existsSync(configPath)) {
    const config = require(configPath);
    apiKey = config.jupiter?.apiKey || null;
  }
} catch (error) {
  console.error('Error loading config:', error.message);
}

// Determine which endpoint to use based on API key
const apiBaseUrl = apiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';

// Test endpoints
async function testEndpoints() {
  console.log(`Testing Jupiter API endpoints with ${apiKey ? 'API key' : 'no API key'}...`);
  console.log(`Using endpoint: ${apiBaseUrl}`);
  
  try {
    // Test the quote endpoint
    const quoteParams = new URLSearchParams({
      inputMint: 'So11111111111111111111111111111111111111112', // SOL
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      amount: '100000000', // 0.1 SOL in lamports
      slippageBps: '50', // 0.5% slippage
    });
    
    // Set up headers
    const headers = {
      'Content-Type': 'application/json',
    };
    
    if (apiKey) {
      headers['Jupiter-API-Key'] = apiKey;
    }
    
    console.log('Testing quote endpoint...');
    const quoteResponse = await fetch(`${apiBaseUrl}/swap/v1/quote?${quoteParams.toString()}`, {
      method: 'GET',
      headers,
    });
    
    if (quoteResponse.ok) {
      const quoteData = await quoteResponse.json();
      console.log('✅ Quote endpoint test successful!');
      console.log(`Output amount: ${quoteData.outAmount} (${quoteData.outAmountWithSlippage} with slippage)`);
    } else {
      const errorText = await quoteResponse.text();
      console.error(`❌ Quote endpoint test failed with status ${quoteResponse.status}: ${errorText}`);
    }
    
    console.log('\nEndpoint test complete.');
    
    if (apiBaseUrl.includes('lite-api') && !apiKey) {
      console.log('\nYou are using the free tier endpoint (lite-api.jup.ag).');
      console.log('This is the correct endpoint for free usage as of the March 2025 Jupiter API update.');
    } else if (apiBaseUrl.includes('api.jup.ag') && apiKey) {
      console.log('\nYou are using the paid tier endpoint (api.jup.ag) with an API key.');
      console.log('This is the correct endpoint for paid usage as of the March 2025 Jupiter API update.');
    } else if (apiBaseUrl.includes('api.jup.ag') && !apiKey) {
      console.log('\n⚠️ WARNING: You are using the paid tier endpoint (api.jup.ag) without an API key.');
      console.log('As of May 1, 2025, this will result in 401 errors. Please update to use lite-api.jup.ag for free usage.');
    }
  } catch (error) {
    console.error('Error testing endpoints:', error.message);
  }
}

// Run the test
testEndpoints().catch(console.error);