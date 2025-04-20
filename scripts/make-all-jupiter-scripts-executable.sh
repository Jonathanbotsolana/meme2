#!/bin/bash

# Make all Jupiter-related scripts executable

echo "Making all Jupiter-related scripts executable..."

# Update scripts
chmod +x "$(dirname "$0")/update-jupiter-api.sh"
chmod +x "$(dirname "$0")/update-jupiter-endpoints.js"

# Test scripts
chmod +x "$(dirname "$0")/test-jupiter-api.sh"
chmod +x "$(dirname "$0")/test-jupiter-endpoints.js"

# Make this script executable
chmod +x "$0"

echo "All Jupiter-related scripts are now executable."
echo "\nAvailable scripts:"
echo "- ./scripts/update-jupiter-api.sh: Update your bot to use the new Jupiter API endpoints"
echo "- ./scripts/test-jupiter-api.sh: Test the Jupiter API endpoints"
echo "\nRemember: Free users must migrate to lite-api.jup.ag by May 1, 2025"