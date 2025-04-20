# Jupiter API Changes - March 2025

## Improved API Gateway

Jupiter has made significant improvements to their API Gateway infrastructure:

- Reduced latency in responses and much more consistent performance
- Infrastructure costs reduction (will help with reducing costs of plans with higher rate limits)
- Dual endpoint structure moving forward

## Dual Endpoint Structure

Jupiter will be deploying 2 different endpoints:

1. `api.jup.ag` - Will serve only pro/paid users
2. `lite-api.jup.ag` - Will be the endpoint to provide free usage

## ACTION REQUIRED (only for free usage)

- Migrate to `lite-api.jup.ag` BY 1 MAY 2025
- The paths remain unchanged, only domain change
- The same rate limits still apply
- You do not need an API Key to use the APIs for free
- If you are still on `api.jup.ag` without an API key, you will get a 401 response

## NO action required for higher rate limit plans via Portal

- Usage on `api.jup.ag` remains unchanged
- You can only use `api.jup.ag` with an API Key

## Trigger API: New Hostname and Breaking Changes

Last updated: March 2025

- The `/limit/v2` path will be deprecated soon, please update your API calls to use the `/trigger/v1` path immediately.
- `/execute` endpoint is introduced.
- `/createOrder` endpoint now includes an additional `requestId` parameter to be used with the `/execute` endpoint.
- `/cancelOrder` endpoint only builds the transaction for 1 order, while `/cancelOrders` endpoint builds the transaction for multiple orders.
- The `tx` field in the responses are now `transaction` or `transactions`.
- `/getTriggerOrders` endpoint introduces a new format to get either active or historical orders (based on the query parameters).

## Hostname Changes

### Trigger API

| Old Hostnames | New Hostnames |
|---------------|---------------|
| https://api.jup.ag/limit/v2/createOrder | https://lite-api.jup.ag/trigger/v1/createOrder |
| https://api.jup.ag/limit/v2/executeOrder | https://lite-api.jup.ag/trigger/v1/executeOrder |
| https://api.jup.ag/limit/v2/cancelOrder | https://lite-api.jup.ag/trigger/v1/cancelOrder |
| | https://lite-api.jup.ag/trigger/v1/cancelOrders |
| https://api.jup.ag/limit/v2/openOrders | https://lite-api.jup.ag/trigger/v1/getTriggerOrders |
| https://api.jup.ag/limit/v2/orderHistory | https://lite-api.jup.ag/trigger/v1/getTriggerOrders |