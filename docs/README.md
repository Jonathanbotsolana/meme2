# Solana Jupiter Swap Encoding Fix

This repository contains a fix for the encoding issue in the lower-case package that was causing the application to crash.

## ⚠️ IMPORTANT: Jupiter API Changes - Action Required by May 1, 2025 ⚠️

Jupiter has announced significant changes to their API infrastructure. Please read the [README-JUPITER-UPDATE.md](README-JUPITER-UPDATE.md) file for details and required actions.

To configure your environment for these changes, run:

```bash
./setup-jupiter-api.sh
```

If the script is not executable, run:

```bash
chmod +x setup-jupiter-api.sh
./setup-jupiter-api.sh
```

## How to Fix Encoding Issues

Run the following command to fix the encoding issue:

```bash
node fix-encoding.js
```

This will replace the problematic file in the node_modules directory with a properly encoded version.

## What was the issue?

The issue was in the `lower-case` package's `index.js` file, which contained special Unicode characters that were not properly encoded. This caused a syntax error when Node.js tried to parse the file.

The error was:
```
SyntaxError: Invalid or unexpected token
```

Specifically, the problematic line was:
```
Ä°: "\u0069",
```

The fix replaces these problematic characters with their proper Unicode escape sequences.