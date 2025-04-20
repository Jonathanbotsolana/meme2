#!/bin/bash

# Script to install and configure ApeJupiter integration

echo "Installing ApeJupiter integration for Kairos Meme Bot..."

# Make sure we're in the project root directory
cd "$(dirname "$0")/.." || exit 1

# Check if .env file exists, create if not
if [ ! -f .env ]; then
  echo "Creating .env file..."
  cp sample.env.optimized .env
fi

# Update .env file with ApeJupiter settings
if grep -q "USE_APE_JUPITER" .env; then
  echo "ApeJupiter settings already exist in .env"
else
  echo "Adding ApeJupiter settings to .env..."
  cat << EOF >> .env

# ApeJupiter Settings
USE_APE_JUPITER=true
APE_JUPITER_API_URL=https://lite-api.jup.ag/swap/v1
APE_JUPITER_API_KEY=
USE_MEV_PROTECTION=true
FALLBACK_TO_JUPITER=true
PRIORITIZE_NEW_TOKENS=true
MIN_TOKEN_AGE=3600
APE_MAX_PRICE_IMPACT_PCT=10.0
EOF
fi

# Install dependencies
echo "Installing dependencies..."
npm install

# Create necessary directories
mkdir -p logs/ape-jupiter

echo "ApeJupiter integration installed successfully!"
echo "You can now use ApeJupiter for memecoin trading in your Kairos Meme Bot."
echo "To enable/disable ApeJupiter, set USE_APE_JUPITER=true/false in your .env file."