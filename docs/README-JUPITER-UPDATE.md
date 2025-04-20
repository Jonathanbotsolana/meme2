# Important Jupiter API Update - Action Required

## What's Changed

Jupiter has announced significant changes to their API infrastructure:

1. They are moving to a dual endpoint structure:
   - `api.jup.ag` - For paid users only (requires API key)
   - `lite-api.jup.ag` - For free usage

2. The Trigger API (formerly Limit Orders) has breaking changes:
   - Path changed from `/limit/v2` to `/trigger/v1`
   - New endpoints and parameter requirements

## Action Required By May 1, 2025

### For Free Usage

If you're using the free tier of Jupiter API:

1. Update all API calls to use `lite-api.jup.ag` instead of `api.jup.ag`
2. No API key is required for the free tier
3. If you continue using `api.jup.ag` without an API key after May 1, 2025, you will receive 401 errors

### For Paid Plans

If you're subscribed to a paid plan via the Jupiter Portal:

1. Continue using `api.jup.ag`
2. Ensure your API key is included in all requests

## How We've Updated Our Code

We've made the following changes to our codebase:

1. Updated the API base URL to use the appropriate endpoint based on whether an API key is configured
2. Added support for including the API key in requests when available
3. Updated all endpoint references to use the latest paths

## How to Configure Your API Key

If you have a paid Jupiter API plan, set your API key as an environment variable:

```
export JUPITER_API_KEY=your_api_key_here
```

Or add it to your environment configuration file.

## Additional Information

For more details about these changes, please refer to:

1. The official Jupiter documentation
2. The `JUPITER_API_CHANGES.md` file in this repository

If you have any questions or encounter issues with this update, please contact our support team.