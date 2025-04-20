#!/bin/bash

# Script to optimize RPC settings for Kairos Meme Bot

echo "Optimizing RPC settings for Kairos Meme Bot..."

# Make sure we're in the project root directory
cd "$(dirname "$0")/.." || exit 1

# Check if .env file exists, create if not
if [ ! -f .env ]; then
  echo "Creating .env file..."
  cp sample.env.optimized .env
fi

# Update .env file with optimized RPC settings
if grep -q "SOLANA_RPC_URL" .env; then
  echo "Updating RPC settings in .env..."
  # Use sed to replace or add RPC settings
  sed -i 's|^SOLANA_RPC_URL=.*|SOLANA_RPC_URL=https://solana-rpc.publicnode.com|' .env
  sed -i 's|^MAX_REQUESTS_PER_10_SEC=.*|MAX_REQUESTS_PER_10_SEC=30|' .env
  sed -i 's|^MAX_REQUESTS_PER_METHOD_10_SEC=.*|MAX_REQUESTS_PER_METHOD_10_SEC=15|' .env
  sed -i 's|^ENABLE_THROTTLING=.*|ENABLE_THROTTLING=true|' .env
  sed -i 's|^RPC_RETRY_DELAY=.*|RPC_RETRY_DELAY=5000|' .env
  sed -i 's|^MAX_RPC_RETRIES=.*|MAX_RPC_RETRIES=10|' .env
else
  echo "Adding RPC settings to .env..."
  cat << EOF >> .env

# Optimized RPC Settings
SOLANA_RPC_URL=https://solana-rpc.publicnode.com
MAX_REQUESTS_PER_10_SEC=30
MAX_REQUESTS_PER_METHOD_10_SEC=15
ENABLE_THROTTLING=true
RPC_RETRY_DELAY=5000
MAX_RPC_RETRIES=10
EOF
fi

# Run the RPC endpoint test to find the best endpoints
echo -e "\nTesting RPC endpoints to find the most reliable ones..."
node scripts/test-rpc-endpoints.js

echo -e "\nRPC settings optimization complete!"
echo "You may want to update your config.js file with the recommended endpoints from the test results above."
echo "To apply these changes, restart your bot with: pm2 restart kairos-meme-bot"