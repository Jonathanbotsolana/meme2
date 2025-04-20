#!/bin/bash

# Script to update Jupiter API endpoints

echo "Updating Jupiter API endpoints..."

# Make the script executable
chmod +x "$(dirname "$0")/update-jupiter-endpoints.js"

# Run the update script
node "$(dirname "$0")/update-jupiter-endpoints.js"

# Create a backup of the current swapExecutor.js file
cp "$(dirname "$0")/../src/modules/swapExecutor.js" "$(dirname "$0")/../src/modules/swapExecutor.js.bak"

# Update the swapExecutor.js file manually
sed -i 's|https://api.jup.ag|https://lite-api.jup.ag|g' "$(dirname "$0")/../src/modules/swapExecutor.js"

echo "\nManual update of swapExecutor.js completed."
echo "A backup of the original file has been created at src/modules/swapExecutor.js.bak"

echo "\nJupiter API update complete!"
echo "Remember: Free users must migrate to lite-api.jup.ag by May 1, 2025"
echo "Paid users with API keys will continue using api.jup.ag"