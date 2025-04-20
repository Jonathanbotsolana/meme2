#!/bin/bash

# Script to test Jupiter API endpoints

echo "Testing Jupiter API endpoints..."

# Make the test script executable
chmod +x "$(dirname "$0")/test-jupiter-endpoints.js"

# Run the test script
node "$(dirname "$0")/test-jupiter-endpoints.js"

echo "\nTest complete."
echo "Remember: Free users must migrate to lite-api.jup.ag by May 1, 2025"
echo "Paid users with API keys will continue using api.jup.ag"