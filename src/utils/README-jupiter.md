# Jupiter API Integration with PumpSwap

This directory contains utilities for interacting with Jupiter API with proper rate limiting, and PumpSwap integration for tokens not available on Jupiter.

## Components

### JupiterRateLimiter

The `jupiterRateLimiter.js` file implements a rate limiter for Jupiter API calls based on different tiers. It uses the token bucket algorithm for rate limiting with separate buckets for regular API calls and Price API calls.

#### Features

- Supports all Jupiter API tiers (free, proI, proII, proIII, proIV)
- Implements token bucket algorithm for rate limiting
- Separate rate limiting for Price API calls (for paid tiers)
- Request queuing and concurrency control
- Automatic retries with exponential backoff
- Detailed statistics and status reporting

#### Usage

```javascript
const JupiterRateLimiter = require('./jupiterRateLimiter');

// Create rate limiter with tier configuration
const rateLimiter = new JupiterRateLimiter({
  tier: 'proII', // 'free', 'proI', 'proII', 'proIII', 'proIV'
  apiKey: 'YOUR_JUPITER_API_KEY', // Required for paid tiers
  maxConcurrentRequests: 2,
  maxRetries: 10,
  debug: true
});

// Execute a function with rate limiting
const result = await rateLimiter.execute(async () => {
  // Your API call here
  return await someApiCall();
});

// For Price API calls, specify isPriceApi = true
const price = await rateLimiter.execute(
  async () => {
    return await fetch(`${rateLimiter.getApiHostname()}/v4/price?ids=SOL`);
  },
  true // This is a Price API call
);
```

### JupiterApiClient

The `jupiterApiClient.js` file provides a higher-level client for interacting with Jupiter API. It uses the JupiterRateLimiter internally and provides methods for common Jupiter API operations. It also includes integration with Jupiter's PumpSwap API for tokens not available on Jupiter's main API.

#### Features

- Token price information
- Token details and metadata
- Swap quotes
- Token tradability checking
- Caching for token information
- PumpSwap integration for tokens not available on Jupiter

#### Usage

```javascript
const JupiterApiClient = require('./jupiterApiClient');

// Create Jupiter API client
const jupiterClient = new JupiterApiClient({
  tier: 'free', // Use 'free', 'proI', 'proII', 'proIII', or 'proIV'
  apiKey: null, // API key is required for paid tiers
  debug: true // Enable debug logging
});

// Get token prices
const prices = await jupiterClient.getTokenPrices(['SOL_ADDRESS', 'USDC_ADDRESS']);

// Get token info
const tokenInfo = await jupiterClient.getTokenInfo('TOKEN_ADDRESS');

// Get a quote
const quote = await jupiterClient.getQuote({
  inputMint: 'SOL_ADDRESS',
  outputMint: 'USDC_ADDRESS',
  amount: 100000000, // 0.1 SOL in lamports
  slippageBps: 50 // 0.5% slippage
});

// Check if a token is tradable
const tradability = await jupiterClient.isTokenTradable('TOKEN_ADDRESS');

// Execute a PumpSwap direct swap for tokens not available on Jupiter
const pumpSwapResult = await jupiterClient.executePumpSwapDirectSwap({
  tokenAddress: 'TOKEN_ADDRESS',
  userWallet: 'USER_WALLET',
  solAmount: 0.01, // 0.01 SOL
  priorityFeeLevel: 'medium' // 'low', 'medium', 'high'
});

// Swap with fallback to PumpSwap if not available on Jupiter
const swapResult = await jupiterClient.swapWithFallback({
  tokenAddress: 'TOKEN_ADDRESS',
  userWallet: 'USER_WALLET',
  solAmount: 0.01, // 0.01 SOL
  slippageBps: 500, // 5% slippage
  priorityFeeLevel: 'medium' // 'low', 'medium', 'high'
});
```

## Jupiter PumpSwap API

Jupiter provides a dedicated API for PumpSwap integration. This API allows you to swap tokens that are not available on Jupiter's main API.

### PumpSwap Swap Endpoint

```
POST https://public.jupiterapi.com/pump-fun/swap
```

Parameters:
- `wallet`: User wallet address
- `type`: 'BUY' or 'SELL'
- `mint`: Token mint address
- `inAmount`: Input amount in lamports
- `priorityFeeLevel`: 'low', 'medium', or 'high'

### PumpSwap Instructions Endpoint

```
POST https://public.jupiterapi.com/pump-fun/swap-instructions
```

Parameters:
- `wallet`: User wallet address
- `type`: 'BUY' or 'SELL'
- `mint`: Token mint address
- `inAmount`: Input amount in lamports
- `priorityFeeLevel`: 'low', 'medium', or 'high'

## Jupiter API Tiers

Jupiter offers different API tiers with varying rate limits:

| Tier   | Requests/Min | Tokens Allocated | Separate Price Bucket | Hostname        |
|--------|--------------|------------------|----------------------|----------------|
| free   | 60           | 10               | No                   | quote-api.jup.ag |
| proI   | 600          | 100              | Yes                  | api.jup.ag     |
| proII  | 3,000        | 500              | Yes                  | api.jup.ag     |
| proIII | 6,000        | 1,000            | Yes                  | api.jup.ag     |
| proIV  | 30,000       | 5,000            | Yes                  | api.jup.ag     |

Paid tiers require an API key. You can get an API key by contacting Jupiter.

## Examples

- See the `examples/jupiterApiExample.js` file for a complete example of using the Jupiter API client.
- See the `examples/jupiterPumpSwapExample.js` file for a complete example of using the Jupiter PumpSwap API integration.