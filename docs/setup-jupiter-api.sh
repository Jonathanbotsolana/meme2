#!/bin/bash

# Script to set up Jupiter API configuration

echo "Jupiter API Configuration Setup"
echo "==============================="
echo ""

echo "This script will help you configure your environment for the Jupiter API changes."
echo "By May 1, 2025, all free users must migrate to lite-api.jup.ag."
echo ""

# Ask if the user has a paid Jupiter API plan
read -p "Do you have a paid Jupiter API plan? (y/n): " has_paid_plan

if [[ "$has_paid_plan" =~ ^[Yy]$ ]]; then
    # Ask for the API key
    read -p "Enter your Jupiter API key: " api_key
    
    # Check if the API key is not empty
    if [ -z "$api_key" ]; then
        echo "Error: API key cannot be empty for paid plans."
        exit 1
    fi
    
    # Create or update .env file with the API key
    if [ -f ".env" ]; then
        # Check if JUPITER_API_KEY already exists in .env
        if grep -q "JUPITER_API_KEY=" .env; then
            # Replace existing JUPITER_API_KEY
            sed -i "s/JUPITER_API_KEY=.*/JUPITER_API_KEY=$api_key/" .env
        else
            # Add JUPITER_API_KEY to .env
            echo "JUPITER_API_KEY=$api_key" >> .env
        fi
    else
        # Create new .env file with JUPITER_API_KEY
        echo "JUPITER_API_KEY=$api_key" > .env
    fi
    
    echo ""
    echo "✅ API key configured successfully."
    echo "You will use api.jup.ag with your API key for all Jupiter API requests."
    
    # Export the API key for the current session
    export JUPITER_API_KEY="$api_key"
    echo "API key exported for the current session."
    echo "To make this permanent, add the following line to your .bashrc or .zshrc file:"
    echo "export JUPITER_API_KEY=\"$api_key\""
    
    echo ""
    echo "No further action is required. Your setup is complete."
    
 else
    echo ""
    echo "You are using the free tier of Jupiter API."
    echo "By May 1, 2025, you must update all your API calls to use lite-api.jup.ag instead of api.jup.ag."
    echo "We have already updated our codebase to use the appropriate endpoint."
    
    # Remove JUPITER_API_KEY from .env if it exists
    if [ -f ".env" ] && grep -q "JUPITER_API_KEY=" .env; then
        sed -i "/JUPITER_API_KEY=/d" .env
        echo "Removed any existing API key configuration."
    fi
    
    # Unset JUPITER_API_KEY if it's set in the current environment
    if [ ! -z "$JUPITER_API_KEY" ]; then
        unset JUPITER_API_KEY
        echo "Unset JUPITER_API_KEY in the current session."
        echo "If you have JUPITER_API_KEY in your .bashrc or .zshrc, please remove it."
    fi
    
    echo ""
    echo "✅ Configuration complete. You will use lite-api.jup.ag for all Jupiter API requests."
fi

echo ""
echo "For more information about the Jupiter API changes, please refer to:"
echo "1. README-JUPITER-UPDATE.md"
echo "2. JUPITER_API_CHANGES.md"