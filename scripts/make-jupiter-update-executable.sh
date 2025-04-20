#!/bin/bash

# Make Jupiter update scripts executable
chmod +x "$(dirname "$0")/update-jupiter-api.sh"
chmod +x "$(dirname "$0")/update-jupiter-endpoints.js"

echo "Jupiter update scripts are now executable."
echo "Run ./scripts/update-jupiter-api.sh to update your bot to use the new Jupiter API endpoints."