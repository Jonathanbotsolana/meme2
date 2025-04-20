// check-jupiter-api.js
// Script to check if you're using the correct Jupiter API endpoint

const axios = require('axios');

// Get API key from environment variable
const apiKey = process.env.JUPITER_API_KEY;

// Determine which endpoint to use based on API key
const baseUrl = apiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';

async function checkJupiterApi() {
  console.log('Jupiter API Endpoint Check');
  console.log('========================');
  console.log('');
  
  console.log(`Using endpoint: ${baseUrl}`);
  console.log(`API Key configured: ${apiKey ? 'Yes' : 'No'}`);
  console.log('');
  
  // Test endpoints
  try {
    // Test the price endpoint
    const solMint = 'So11111111111111111111111111111111111111112';
    const priceUrl = `${baseUrl}/v6/price?ids=${solMint}`;
    
    console.log(`Testing price endpoint: ${priceUrl}`);
    
    const headers = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    
    const response = await axios.get(priceUrl, { headers });
    
    if (response.status === 200) {
      console.log('✅ Price endpoint test successful!');
      console.log(`SOL price: $${response.data.data[solMint].price}`);
    } else {
      console.log(`❌ Price endpoint test failed with status: ${response.status}`);
    }
  } catch (error) {
    console.log('❌ Price endpoint test failed with error:');
    if (error.response) {
      console.log(`Status: ${error.response.status}`);
      console.log(`Message: ${JSON.stringify(error.response.data)}`);
      
      if (error.response.status === 401) {
        console.log('');
        console.log('⚠️ You received a 401 Unauthorized error. This means:');
        console.log('1. You are trying to use api.jup.ag without an API key, or');
        console.log('2. Your API key is invalid or expired');
        console.log('');
        console.log('SOLUTION:');
        console.log('- If you have a paid plan, make sure your API key is correctly set');
        console.log('- If you are using the free tier, you must use lite-api.jup.ag');
        console.log('');
        console.log('Run ./setup-jupiter-api.sh to configure your environment correctly.');
      }
    } else {
      console.log(error.message);
    }
  }
  
  console.log('');
  console.log('For more information about the Jupiter API changes, please refer to:');
  console.log('1. README-JUPITER-UPDATE.md');
  console.log('2. JUPITER_API_CHANGES.md');
}

checkJupiterApi();