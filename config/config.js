require('dotenv').config();

module.exports = {
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://hidden-indulgent-card.solana-mainnet.quiknode.pro/88200bf9df13e5a27afeadbd45afa50be60273b9/',
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY || '',
    walletKeypairPath: process.env.WALLET_KEYPAIR_PATH || '../meme3/phantom-keypair.json',
    // List of backup RPC endpoints to use when the primary one fails
    rpcEndpoints: [
      // Most reliable endpoints (based on test results)
      'https://hidden-indulgent-card.solana-mainnet.quiknode.pro/88200bf9df13e5a27afeadbd45afa50be60273b9/',
      'https://mainnet.helius-rpc.com/?api-key=f7e0528e-7e2d-404f-8ae7-e774405c422f',
      'https://api.mainnet-beta.solana.com',
    ],
    // RPC endpoints with weights for load balancing
    weightedRpcEndpoints: {
      'https://mainnet.helius-rpc.com/?api-key=f7e0528e-7e2d-404f-8ae7-e774405c422f': 3, // Helius premium
      'https://solana.getblock.io/mainnet/': 2, // GetBlock
      'https://solana.blockdaemon.com': 2, // Blockdaemon
      'https://api.mainnet-beta.solana.com': 1, // Solana official
    },
    // Solana mainnet limits
    rateLimit: {
      // Maximum requests per 10 seconds (Solana mainnet limit is 100)
      maxRequestsPer10Sec: parseInt(process.env.MAX_REQUESTS_PER_10_SEC || '40'), // Increased for faster processing
      // Maximum requests per 10 seconds for a single RPC method (Solana mainnet limit is 40)
      maxRequestsPerMethodPer10Sec: parseInt(process.env.MAX_REQUESTS_PER_METHOD_10_SEC || '20'),
      // Maximum number of retries for RPC requests
      maxRpcRetries: parseInt(process.env.MAX_RPC_RETRIES || '15'), // Reduced to avoid excessive retries with fewer endpoints
      // Enable request throttling to stay under rate limits
      enableThrottling: process.env.ENABLE_THROTTLING !== 'false',
      // Use adaptive rate limiting based on RPC endpoint response times
      adaptiveRateLimiting: true,
      // Minimum delay between requests in milliseconds
      minRequestDelay: 50,
    },
    // Transaction confirmation settings
    transactionConfirmation: {
      // Maximum number of confirmation attempts
      maxConfirmationAttempts: 25,
      // Delay between confirmation attempts in milliseconds
      confirmationDelayMs: 1000,
      // Whether to use preflight transaction checks
      usePreflightChecks: true,
      // Whether to skip preflight checks in high congestion scenarios
      skipPreflight: false,
      // Maximum transaction timeout in milliseconds
      maxTransactionTimeoutMs: 90000, // 90 seconds
      // Whether to use priority fees for faster confirmation
      usePriorityFees: true,
      // Base priority fee in micro-lamports
      basePriorityFeeMicroLamports: 10000,
    },
  },
  trading: {
    enabled: true, // Always enable trading
    testMode: process.env.TEST_MODE === 'true', // Enable test mode with smaller amounts
    maxTradeSizeSol: parseFloat(process.env.MAX_TRADE_SIZE_SOL || '0.08'), // Increased for better profit potential
    minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '100'), // Decreased to catch more early opportunities
    minVolumeUsd: parseFloat(process.env.MIN_VOLUME_USD || '200'), // Decreased to catch more early opportunities
    tpPercentage: parseFloat(process.env.TP_PERCENTAGE || '150'), // Increased take profit for trending tokens
    slPercentage: parseFloat(process.env.SL_PERCENTAGE || '20'), // Adjusted stop loss to be tighter
    defaultSlippage: parseFloat(process.env.DEFAULT_SLIPPAGE || '60.0'), // Increased for better execution with very low liquidity tokens
    maxRetryAttempts: parseInt(process.env.MAX_RETRY_ATTEMPTS || '25'), // Further increased retry attempts
    retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || '800'), // Decreased delay between retries for faster execution
    
    // Advanced trading strategies
    tradingStrategies: {
      // Dynamic position sizing based on token characteristics
      dynamicPositionSizing: {
        enabled: true,
        // Base position size as percentage of available capital
        basePositionSizePercent: 6,
        // Maximum position size as percentage of available capital
        maxPositionSizePercent: 15,
        // Minimum position size as percentage of available capital
        minPositionSizePercent: 3,
        // Factors that increase position size
        increaseFactors: {
          highVolume: 1.8, // Increase for high volume tokens
          strongPriceMovement: 2.0, // Increase for strong price movements
          highSocialSentiment: 1.5, // Increase for tokens with positive social sentiment
          newToken: 1.7, // Increase for very new tokens
          lowMarketCap: 1.6, // Increase for low market cap tokens with growth potential
          strongBuyPressure: 1.5, // Increase for tokens with strong buy pressure
        },
        // Factors that decrease position size
        decreaseFactors: {
          lowLiquidity: 0.6, // Decrease for low liquidity tokens
          highVolatility: 0.7, // Decrease for highly volatile tokens
          lowHolderCount: 0.8, // Decrease for tokens with few holders
          suspiciousTokenomics: 0.5, // Decrease for tokens with suspicious tokenomics
        },
      },
      // Dynamic take profit and stop loss based on token characteristics
      dynamicExitStrategy: {
        enabled: true,
        // Base take profit percentage
        baseTpPercentage: 150,
        // Base stop loss percentage
        baseSlPercentage: 20,
        // Maximum take profit percentage
        maxTpPercentage: 300,
        // Maximum stop loss percentage
        maxSlPercentage: 30,
        // Factors that increase take profit target
        tpIncreaseFactors: {
          highVolatility: 1.7, // Increase for highly volatile tokens
          strongMomentum: 2.0, // Increase for tokens with strong momentum
          highSocialSentiment: 1.5, // Increase for tokens with positive social sentiment
          lowMarketCap: 1.6, // Increase for low market cap tokens with growth potential
          newListing: 1.8, // Increase for newly listed tokens
        },
        // Factors that decrease stop loss distance
        slDecreaseFactors: {
          lowLiquidity: 0.7, // Tighter stop loss for low liquidity tokens
          highVolatility: 0.6, // Tighter stop loss for highly volatile tokens
          weakBuyPressure: 0.8, // Tighter stop loss for tokens with weak buy pressure
          suspiciousActivity: 0.5, // Tighter stop loss for tokens with suspicious activity
        },
        // Dynamic adjustment based on market conditions
        marketConditionAdjustment: {
          enabled: true,
          bullishMarket: 1.2, // Increase targets in bullish market
          bearishMarket: 0.8, // Decrease targets in bearish market
          sidewaysMarket: 1.0, // No change in sideways market
        },
      },
      // Trailing stop loss strategy
      trailingStopLoss: {
        enabled: true,
        // Initial trailing distance as percentage
        initialTrailingDistancePercent: 12,
        // Activation threshold (profit percentage when trailing begins)
        activationThresholdPercent: 15,
        // Step size for trailing stop adjustments
        stepSizePercent: 3,
        // Maximum trailing distance
        maxTrailingDistancePercent: 20,
        // Minimum trailing distance
        minTrailingDistancePercent: 8,
        // Dynamic adjustment based on volatility
        dynamicAdjustment: {
          enabled: true,
          // Volatility multiplier for trailing distance
          volatilityMultiplier: 1.5,
          // Minimum volatility to trigger adjustment
          minVolatilityPercent: 5,
          // Maximum volatility to consider
          maxVolatilityPercent: 30,
        },
        // Accelerated trailing in strong uptrends
        acceleratedTrailing: {
          enabled: true,
          // Profit threshold to activate accelerated trailing
          activationThresholdPercent: 50,
          // Acceleration factor for trailing distance
          accelerationFactor: 0.8,
        },
      },
      // Partial profit taking strategy
      partialProfitTaking: {
        enabled: true,
        // List of profit targets and percentage to sell at each target
        profitTargets: [
          { targetPercent: 25, sellPercent: 15 }, // Sell 15% of position at 25% profit
          { targetPercent: 50, sellPercent: 25 }, // Sell 25% of position at 50% profit
          { targetPercent: 100, sellPercent: 30 }, // Sell 30% of position at 100% profit
          { targetPercent: 200, sellPercent: 20 }, // Sell 20% of position at 200% profit
        ],
        // Whether to adjust stop loss after partial profit taking
        adjustStopLossAfterPartialSell: true,
        // Minimum remaining position size after partial sells
        minRemainingPositionPercent: 10,
        // Dynamic adjustment based on token momentum
        dynamicAdjustment: {
          enabled: true,
          // Increase sell percentage for tokens losing momentum
          increaseSellForWeakMomentum: true,
          // Decrease sell percentage for tokens gaining momentum
          decreaseSellForStrongMomentum: true,
          // Momentum adjustment factor
          momentumAdjustmentFactor: 0.2,
        },
        // Reinvestment strategy for profits
        reinvestmentStrategy: {
          enabled: true,
          // Percentage of profits to reinvest in new opportunities
          reinvestmentPercent: 50,
          // Minimum profit to trigger reinvestment
          minProfitForReinvestment: 30,
        },
      },
    },
    
    // Pair filtering for trading decisions focused on trending tokens
    pairFiltering: {
      // Only consider pairs with these base tokens
      baseTokens: ['SOL', 'USDC', 'USDT'],
      // Exclude established tokens to focus on new trends
      excludeTokens: [
        'SOLANA', 'MPX6900', 'BONK', 'WIF', 'SAMO', 'MEME', 'JUP', 'PYTH', 'RAY', 'ORCA',
        'USDC', 'USDT', 'SOL', 'ETH', 'BTC', 'MSOL', 'STSOL', 'JSOL', 'BSOL',
        'BORK', 'POPCAT', 'SLERF', 'SLOTH', 'NOPE', 'TOAD'
      ],
      // Reduced minimum liquidity to catch newer trending tokens
      minLiquidityUsd: 80,
      // Reduced minimum volume to catch newer trending tokens
      minVolumeUsd: 150,
      // Reduced maximum age to focus on newer pairs
      maxPairAgeHours: 48,
      // Increased minimum price change to focus on trending tokens
      minPriceChangePercentage: 8,
      // Minimum price increase in the last hour to be considered trending
      minPriceIncrease1h: 4,
      // Minimum volume increase in the last hour to be considered trending
      minVolumeIncrease1h: 15,
      // Maximum market cap for a token to be considered a new trend (in USD)
      maxMarketCapUsd: 8000000,
      // Minimum number of transactions in the last hour
      minTransactionsLastHour: 8,
      // Minimum unique buyers in the last hour
      minUniqueBuyersLastHour: 4,
      // Prioritize tokens with trending characteristics
      prioritizeTrending: true,
      // Minimum social media mentions to consider as trending
      minSocialMentions: 2,
      // Advanced filtering options
      advancedFiltering: {
        // Filter out potential rug pulls
        filterPotentialRugs: true,
        // Minimum LP token burn percentage to consider legitimate
        minLpTokenBurnPercent: 80,
        // Maximum creator token allocation percentage
        maxCreatorAllocationPercent: 15,
        // Minimum time lock period for creator tokens (in days)
        minCreatorTokenLockDays: 7,
        // Check for honeypot characteristics
        detectHoneypots: true,
        // Check for contract vulnerabilities
        checkContractSecurity: true,
        // Minimum buy/sell transaction ratio to filter manipulation
        minBuySellRatio: 1.2,
        // Maximum single wallet ownership percentage
        maxSingleWalletOwnershipPercent: 20,
        // Minimum number of holders with >1% ownership
        minSignificantHolders: 3,
      },
    },
    
    // Additional Jupiter API endpoints
    jupiterApiEndpoints: {
      quote: '/quote',
      swap: '/swap',
      swapInstructions: '/swap-instructions',
      programIdToLabel: '/program-id-to-label',
      indexedRouteMap: '/indexed-route-map'
    },
    // Jupiter specific settings
    // Jupiter specific settings
    jupiter: {
      // API base URL for Jupiter
      apiBaseUrl: process.env.JUPITER_API_URL || 'https://lite-api.jup.ag/swap/v1',
      // Professional API URL (with API key)
      proApiBaseUrl: 'https://api.jup.ag',
      // API key for Jupiter (if available)
      apiKey: process.env.JUPITER_API_KEY || '',
      // Fallback tokens to use as intermediaries when direct routes aren't available
      routingTokens: [
        'So11111111111111111111111111111111111111112', // SOL (Wrapped SOL)
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
        'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
        'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
        '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
        'F6v4wfAdJB8D8p77bMXZgYt8TDKsYxLYxH5AFhUkYx9W', // WIF
        'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF (dogwifhat)
        'A9o4K7Li3u1E8Rw7Lj3BWtVzH3tgaBtfdV2iGjCpjJE5', // USDC (v2)
        'AgdBbYPwxvLqMke4i6d5Zbk8U7RUv6Q9WR7zNCKnNHoS', // USDH
        '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
        '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', // SAMO
        'kinXdEcpDQeHPEuQnqmUgtYykqKGVFq6CeVX5iAHJq6', // KIN
        'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', // ORCA
        'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
        'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', // PYTH
      ],
      // Use all available market makers for better routing options
      onlyDirectRoutes: false,
      // Exclude certain AMMs that might be problematic
      excludeDexes: [],
      // Minimum amount in USD to swap (to avoid dust amounts)
      minSwapUsd: parseFloat(process.env.MIN_SWAP_USD || '0.5'), // Decreased to allow smaller swaps
      // Maximum impact percentage allowed for swaps
      maxPriceImpactPct: parseFloat(process.env.MAX_PRICE_IMPACT_PCT || '25.0'), // Increased for new tokens
      // Force fetch routes to bypass cache
      forceFetch: true,
      // Additional Jupiter options
      enableFeeSwap: true,
      // Use strict mode for routing (false allows more routes)
      strictMode: false,
      // Whether to wrap and unwrap SOL automatically
      wrapAndUnwrapSol: true,
      // Whether to use dynamic slippage adjustment
      dynamicSlippage: true,
      // Priority fee in lamports to increase transaction priority
      prioritizationFeeLamports: 10000, // 0.00001 SOL
      // Platform fee in basis points (if collecting fees)
      platformFeeBps: 0
    },
    // ApeJupiter specific settings
    apeJupiter: {
      // Whether to use ApeJupiter for memecoin swaps
      enabled: true, // Always enable ApeJupiter for memecoins
      // API base URL for ApeJupiter - using the lite API as documented
      apiBaseUrl: process.env.APE_JUPITER_API_URL || 'https://lite-api.jup.ag/swap/v1',
      // API key for ApeJupiter (if available) - for professional version
      apiKey: process.env.APE_JUPITER_API_KEY || '',
      // Whether to use MEV-protected swaps (via Jito)
      useMevProtection: process.env.USE_MEV_PROTECTION === 'true' || true,
      // Fee percentage charged by ApeJupiter (0.5%)
      feePercentage: 0.5,
      // Increased maximum price impact allowed for trending tokens
      maxPriceImpactPct: parseFloat(process.env.APE_MAX_PRICE_IMPACT_PCT || '55.0'), // Increased for very new trending tokens
      // Reduced minimum token age to catch newer trending tokens
      minTokenAge: parseInt(process.env.MIN_TOKEN_AGE || '120'), // Reduced to 2 minutes to catch newer tokens faster
      // Whether to prioritize new tokens
      prioritizeNewTokens: true, // Always prioritize new tokens
      // Fallback to regular Jupiter if ApeJupiter fails
      fallbackToJupiter: true, // Always fallback to regular Jupiter
      // Alternative API endpoints to try if the main one fails
      alternativeEndpoints: [
        'https://lite-api.jup.ag/swap/v1',
        'https://api.jup.ag',
        'https://quote-api.jup.ag/v6',
        'https://quote-api.jup.ag/v4'
      ],
      // Enhanced settings for trending tokens
      trendingTokens: {
        // Increased maximum price impact for trending tokens
        maxPriceImpactPct: 70.0,
        // Increased slippage tolerance for trending tokens
        slippageTolerance: 80.0,
        // Reduced minimum liquidity for trending tokens
        minLiquidityUsd: 60,
        // Reduced minimum volume for trending tokens
        minVolumeUsd: 100,
        // Maximum age of a token to be considered trending (in minutes)
        maxTokenAgeMinutes: 1440, // 24 hours
        // Whether to use more aggressive trading for trending tokens
        aggressiveTrading: true,
        // Dynamic slippage adjustment based on liquidity and volatility
        dynamicSlippage: {
          enabled: true,
          // Base slippage percentage
          baseSlippagePercent: 50,
          // Maximum slippage percentage
          maxSlippagePercent: 80,
          // Minimum slippage percentage
          minSlippagePercent: 30,
          // Liquidity factor for slippage adjustment
          liquidityFactor: 1.5,
          // Volatility factor for slippage adjustment
          volatilityFactor: 2.0,
        },
        // Priority fee settings for trending tokens
        priorityFees: {
          enabled: true,
          // Base priority fee in micro-lamports
          basePriorityFeeMicroLamports: 15000,
          // Maximum priority fee in micro-lamports
          maxPriorityFeeMicroLamports: 50000,
          // Dynamic adjustment based on network congestion
          dynamicAdjustment: true,
          // Congestion multiplier
          congestionMultiplier: 2.0,
        },
        // Route optimization for trending tokens
        routeOptimization: {
          // Prioritize execution speed over price
          prioritizeSpeed: true,
          // Maximum acceptable price difference for faster execution
          maxPriceDifferencePercent: 3.0,
          // Minimum improvement required to switch routes
          minImprovementPercent: 1.0,
          // Whether to use parallel route queries
          useParallelQueries: true,
        },
      },
      // Advanced execution settings
      advancedExecution: {
        // Whether to use transaction chunking for large swaps
        useTransactionChunking: true,
        // Maximum chunk size in SOL
        maxChunkSizeSol: 0.02,
        // Delay between chunks in milliseconds
        chunkDelayMs: 2000,
        // Whether to use versioned transactions
        useVersionedTransactions: true,
        // Whether to use address lookup tables
        useAddressLookupTables: true,
        // Whether to retry failed transactions with higher priority fees
        retryWithHigherPriorityFee: true,
        // Maximum priority fee increase factor for retries
        maxPriorityFeeIncreaseFactor: 2.0,
      },
    }
  },
  scanner: {
    scanInterval: parseInt(process.env.SCAN_INTERVAL || '15000'), // Further reduced scan interval to catch trends faster
    // Token detection filtering to avoid duplicate token pairs
    tokenDetectionFiltering: {
      enabled: true,
      // Common tokens that should be filtered more strictly
      commonTokens: ['MEME', 'BONK', 'WIF', '$WIF', 'AI', 'SOL', 'SOLANA', 'DOGWIFHAT', 'PEPE', 'DOGE', 'CAT', 'MOON'],
      // Case-insensitive token symbol comparison
      caseInsensitiveComparison: true,
      // Maximum number of pairs to track per token symbol combination
      maxPairsPerTokenSymbol: 4,
      // Minimum liquidity difference to consider a new pair of the same token
      minLiquidityDifferenceUsd: 3000,
      // Prioritize pairs with higher liquidity
      prioritizeHigherLiquidity: true,
      // Maximum tracking set size to prevent memory issues
      maxTrackingSetSize: 7000,
      // Clean up interval in milliseconds
      cleanupIntervalMs: 1800000, // 30 minutes
      // Enhanced token name pattern detection
      enhancedPatternDetection: {
        enabled: true,
        // Common prefixes in trending tokens
        trendingPrefixes: ['BABY', 'MINI', 'SUPER', 'MEGA', 'GIGA', 'TURBO', 'HYPER', 'BASED'],
        // Common suffixes in trending tokens
        trendingSuffixes: ['INU', 'DOGE', 'CAT', 'MOON', 'ROCKET', 'ELON', 'PEPE', 'WOJAK', 'CHAD', 'FROG', 'SHIB'],
        // Weight for pattern matching in token scoring
        patternMatchWeight: 0.3,
      },
    },
    // Multi-source scanning strategy
    multiSourceStrategy: {
      enabled: true,
      // List of data sources to use for scanning
      dataSources: [
        'dexscreener', // Primary source for pair data
        'birdeye', // Alternative source for pair data
        'solscan', // For token metadata
        'jupiter', // For liquidity data
        'twitter', // For social sentiment
        'telegram', // For social sentiment
      ],
      // Minimum number of sources that must detect a trend
      minSourcesForConfirmation: 2,
      // Whether to use weighted scoring based on source reliability
      useWeightedScoring: true,
      // Source reliability weights
      sourceWeights: {
        dexscreener: 1.0,
        birdeye: 0.9,
        solscan: 0.8,
        jupiter: 0.9,
        twitter: 0.7,
        telegram: 0.6,
      },
    },
    // Scanner specific settings
    newPairDetection: {
      enabled: true,
      // Reduced minimum time between scans to catch trends faster
      minScanInterval: 10000,
      // Increased maximum number of new pairs to process
      maxNewPairsPerScan: 25,
      // Reduced minimum liquidity to catch newer trending tokens
      minLiquidityUsd: 120,
      // Whether to automatically trade newly detected pairs
      autoTrade: true,
      // Reduced maximum age to focus on newer pairs
      maxPairAgeHours: 8,
      // Reduced minimum score to catch more potential trending tokens
      minPairScore: 0.15,
      // Prioritize pairs with trending characteristics
      prioritizeTrending: true,
      // Minimum holders for a new pair to be considered legitimate
      minHolders: 3,
      // Maximum time to monitor a new pair before deciding to trade (in seconds)
      maxMonitoringTime: 180,
      // Minimum price increase during monitoring to confirm trend
      minPriceIncreaseWhileMonitoring: 2,
      // Advanced detection settings
      advancedDetection: {
        // Whether to use pattern recognition for early trend detection
        usePatternRecognition: true,
        // Whether to analyze transaction patterns
        analyzeTransactionPatterns: true,
        // Minimum buy transaction percentage
        minBuyTransactionPercent: 60,
        // Minimum unique wallet percentage
        minUniqueWalletPercent: 70,
        // Whether to detect and filter out bot transactions
        filterBotTransactions: true,
        // Whether to analyze token contract for red flags
        analyzeTokenContract: true,
        // Whether to check for liquidity locking
        checkLiquidityLocking: true,
      },
    },
    // Volume spike detection settings
    volumeSpikeDetection: {
      enabled: true,
      // Reduced minimum spike percentage to catch more potential trends
      minSpikePercentage: 25,
      // Reduced minimum volume to catch newer trending tokens
      minVolumeUsd: 800,
      // Reduced time window to focus on more immediate trends
      timeWindowMinutes: 8,
      // Whether to automatically trade volume spike pairs
      autoTrade: true,
      // Maximum market cap for a token to be considered a new trend (in USD)
      maxMarketCapUsd: 5000000,
      // Minimum number of transactions in the spike period
      minTransactionsCount: 8,
      // Ignore spikes that appear to be wash trading
      filterWashTrading: true,
      // Advanced spike analysis
      advancedSpikeAnalysis: {
        // Whether to analyze buy vs sell pressure
        analyzeBuySellPressure: true,
        // Minimum buy pressure percentage
        minBuyPressurePercent: 60,
        // Whether to analyze wallet diversity
        analyzeWalletDiversity: true,
        // Minimum unique wallets percentage
        minUniqueWalletsPercent: 70,
        // Whether to analyze spike sustainability
        analyzeSpikePattern: true,
        // Whether to detect artificial pumps
        detectArtificialPumps: true,
        // Whether to analyze historical spike patterns
        analyzeHistoricalPatterns: true,
      },
    },
    // Price movement detection settings
    priceMovementDetection: {
      enabled: true,
      // Increased minimum price increase to focus on stronger trends
      minPriceIncreasePercentage: 12,
      // Reduced time window to focus on more immediate trends
      timeWindowMinutes: 10,
      // Whether to automatically trade pairs with significant price movements
      autoTrade: true,
      // Minimum number of buys vs sells ratio to confirm trend is real
      minBuySellRatio: 1.3,
      // Minimum number of unique buyers to confirm trend is real
      minUniqueBuyers: 5,
      // Maximum market cap for a token to be considered a new trend (in USD)
      maxMarketCapUsd: 5000000,
      // Advanced price movement analysis
      advancedPriceAnalysis: {
        // Whether to analyze price movement patterns
        analyzePricePatterns: true,
        // Whether to detect potential pump and dump schemes
        detectPumpAndDump: true,
        // Whether to analyze price movement sustainability
        analyzeSustainability: true,
        // Whether to use technical indicators
        useTechnicalIndicators: true,
        // List of technical indicators to use
        technicalIndicators: ['rsi', 'macd', 'volume_oscillator'],
        // Whether to analyze price movement correlation with social media
        analyzeSocialCorrelation: true,
      },
    },
    // Social media trend detection
    socialTrendDetection: {
      enabled: true,
      // Minimum mentions on social media to consider as trending
      minMentionsCount: 4,
      // Time window to look for social media mentions (in minutes)
      timeWindowMinutes: 45,
      // Whether to automatically trade socially trending pairs
      autoTrade: true,
      // Social platforms to monitor
      platforms: ['twitter', 'telegram', 'discord', 'reddit', 'youtube'],
      // Keywords that indicate positive sentiment
      positiveKeywords: ['moon', 'gem', 'pump', 'buy', 'bullish', 'launch', 'new', 'trending', 'early', 'x10', 'x100', 'potential', 'next'],
      // Minimum positive sentiment ratio
      minPositiveSentimentRatio: 0.6,
      // Advanced social analysis
      advancedSocialAnalysis: {
        // Whether to analyze influencer engagement
        analyzeInfluencerEngagement: true,
        // Minimum influencer follower count
        minInfluencerFollowers: 5000,
        // Whether to analyze community growth rate
        analyzeCommunityGrowth: true,
        // Whether to detect coordinated promotion campaigns
        detectCoordinatedCampaigns: true,
        // Whether to analyze sentiment trends over time
        analyzeSentimentTrends: true,
        // Whether to correlate social activity with trading activity
        correlateSocialWithTrading: true,
      },
    },
    // Liquidity analysis
    liquidityAnalysis: {
      enabled: true,
      // Minimum liquidity increase percentage to consider as trending
      minLiquidityIncreasePercent: 20,
      // Time window to analyze liquidity changes (in minutes)
      timeWindowMinutes: 30,
      // Whether to automatically trade pairs with increasing liquidity
      autoTrade: true,
      // Minimum initial liquidity in USD
      minInitialLiquidityUsd: 100,
      // Advanced liquidity analysis
      advancedLiquidityAnalysis: {
        // Whether to analyze liquidity provider diversity
        analyzeLpDiversity: true,
        // Whether to detect liquidity manipulation
        detectLiquidityManipulation: true,
        // Whether to analyze liquidity lock status
        analyzeLiquidityLock: true,
        // Minimum liquidity lock period in days
        minLiquidityLockDays: 7,
        // Whether to analyze liquidity depth
        analyzeLiquidityDepth: true,
        // Whether to monitor for liquidity removal events
        monitorLiquidityRemovals: true,
      },
    },
    // Real-time market analysis
    realTimeMarketAnalysis: {
      enabled: true,
      // Analysis interval in milliseconds
      analysisIntervalMs: 5000,
      // Whether to use adaptive analysis frequency
      useAdaptiveFrequency: true,
      // Maximum analysis frequency in milliseconds
      maxAnalysisFrequencyMs: 2000,
      // Minimum analysis frequency in milliseconds
      minAnalysisFrequencyMs: 10000,
      // Whether to prioritize tokens showing momentum
      prioritizeMomentum: true,
      // Whether to use predictive trend analysis
      usePredictiveTrendAnalysis: true,
      // Whether to correlate with broader market trends
      correlateWithBroaderMarket: true,
    },
  },
  database: {
    dbPath: process.env.DB_PATH || './data/trades.db',
  },
  rpc: {
    endpoints: [
      'https://hidden-indulgent-card.solana-mainnet.quiknode.pro/88200bf9df13e5a27afeadbd45afa50be60273b9/',
      'https://mainnet.helius-rpc.com/?api-key=f7e0528e-7e2d-404f-8ae7-e774405c422f',
      'https://api.mainnet-beta.solana.com'
    ]
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    directory: './logs',
  },
  dashboard: {
    port: parseInt(process.env.DASHBOARD_PORT || '3002'),
    enabled: process.env.DASHBOARD_ENABLED === 'true',
  },
  dexscreener: {
    baseUrl: 'https://api.dexscreener.com/latest/dex',
    pairsEndpoint: '/pairs/solana',
    searchEndpoint: '/search',
    // Advanced API settings
    apiSettings: {
      // Maximum retries for API requests
      maxRetries: 5,
      // Retry delay in milliseconds
      retryDelayMs: 1000,
      // Request timeout in milliseconds
      timeoutMs: 10000,
      // Whether to use a proxy for API requests
      useProxy: false,
      // Whether to cache API responses
      cacheResponses: true,
      // Cache expiration time in milliseconds
      cacheExpirationMs: 30000,
      // Whether to use parallel requests for faster data fetching
      useParallelRequests: true,
      // Maximum number of parallel requests
      maxParallelRequests: 5,
    },
    // Filter settings for pair detection
    pairFilters: {
      // Reduced minimum liquidity to catch newer trending tokens
      minLiquidityUsd: 100,
      // Reduced minimum volume to catch newer trending tokens
      minVolumeUsd: 200,
      // Reduced maximum age to focus on newer pairs
      maxPairAgeHours: 12,
      // Increased minimum price change to focus on trending tokens
      minPriceChangePercentage: 8,
      // Comprehensive list of trending meme coin identifiers (expanded to catch more trends)
      memeTokenIdentifiers: [
        // Generic meme terms
        'meme', 'coin', 'moon', 'pump', 'gem', 'based', 'chad', 'wojak', 'pepe', 'frog', 'kek', 'lol',
        // Animal themes (popular in meme coins)
        'cat', 'dog', 'doge', 'shib', 'inu', 'bull', 'bear', 'ape', 'monkey', 'frog', 'toad', 'fish', 'bird', 'fox', 'panda', 'lion',
        // Internet culture references
        'ai', 'gpt', 'elon', 'musk', 'trump', 'biden', 'wojak', 'chad', 'karen', 'sigma', 'alpha', 'beta', 'gigachad', 'npc',
        // Solana ecosystem specific
        'sol', 'bonk', 'wif', 'samo', 'cope', 'bong', 'dust', 'wen', 'giga', 'orca', 'ray', 'pyth', 'jup', 'jito',
        // Trending themes
        'x', 'meta', 'vr', 'ar', 'web3', 'dao', 'defi', 'nft', 'punk', 'game', 'play', 'earn', 'metaverse',
        // Viral/meme references
        'pepe', 'dank', 'stonk', 'hodl', 'fomo', 'yolo', 'wagmi', 'ngmi', 'gm', 'gn', 'lfg', 'btfd', 'rekt',
        // Emoji references in names
        '🚀', '🌙', '🌕', '💎', '🙌', '🔥', '💰', '🐶', '🐱', '🐸', '🦊', '🦁', '🐻', '🐼',
        // Current year trends
        'turbo', 'hyper', 'mega', 'ultra', 'super', 'epic', 'based', 'sigma', 'alpha', 'chad', 'king', 'queen',
        // Numeric references
        'x10', 'x100', '1000x', '420', '69', '999', '888', '777', '666', '100k', '1m',
        // Prefix/suffix patterns
        'baby', 'mini', 'little', 'big', 'mega', 'giga', 'ultra', 'super', 'hyper', 'turbo', 'pro', 'max', 'plus', 'premium',
      ],
      // Exclude established tokens to focus on new trends
      excludeTokens: [
        // Major tokens
        'SOLANA', 'MPX6900', 'USDC', 'USDT', 'SOL', 'ETH', 'BTC', 'MSOL', 'STSOL', 'JSOL', 'BSOL',
        // Established meme coins
        'BONK', 'WIF', 'SAMO', 'MEME', 'JUP', 'PYTH', 'RAY', 'ORCA', 'BORK', 'POPCAT', 'SLERF', 'SLOTH', 'NOPE', 'TOAD',
        // Other established tokens
        'ORCA', 'RAY', 'SRM', 'STEP', 'ATLAS', 'POLIS', 'COPE', 'FIDA', 'MAPS', 'OXY', 'BOP', 'TULIP', 'SLIM',
      ],
      // Only include pairs with these base tokens
      baseTokens: ['SOL', 'USDC', 'USDT'],
      // Prioritize new pairs over established ones
      prioritizeNewPairs: true,
      // Maximum market cap for a token to be considered a new trend (in USD)
      maxMarketCapUsd: 3000000,
      // Minimum price increase in the last hour to be considered trending
      minPriceIncrease1h: 3,
      // Minimum volume increase in the last hour to be considered trending
      minVolumeIncrease1h: 15,
      // Advanced filtering options
      advancedFiltering: {
        // Whether to use pattern recognition for token names
        usePatternRecognition: true,
        // Whether to analyze token creation patterns
        analyzeCreationPatterns: true,
        // Whether to detect token name trends
        detectNameTrends: true,
        // Whether to analyze token symbol patterns
        analyzeSymbolPatterns: true,
        // Whether to correlate with social media trends
        correlateWithSocialTrends: true,
        // Whether to use machine learning for trend prediction
        useMachineLearning: false, // Disabled by default as it requires additional setup
        // Whether to analyze token contract features
        analyzeTokenContract: true,
        // Whether to detect potential scam patterns
        detectScamPatterns: true,
      },
    },
  },
  tokenScoring: {
    // Optimized weights to prioritize trending characteristics
    volumeWeight: 0.15,
    liquidityWeight: 0.10,
    priceChangeWeight: 0.40, // Heavily prioritize price movement
    holdersWeight: 0.10,
    sentimentWeight: 0.25, // Significantly increased to prioritize social trends
    minScore: 0.12, // Further lowered to catch more potential trending tokens
    // Adaptive scoring system
    adaptiveScoring: {
      enabled: true,
      // Whether to adjust weights based on market conditions
      adjustWeightsBasedOnMarket: true,
      // Whether to use different scoring models for different token types
      useDifferentModels: true,
      // Whether to use historical performance to improve scoring
      useHistoricalPerformance: true,
      // Minimum score adjustment factor
      minAdjustmentFactor: 0.8,
      // Maximum score adjustment factor
      maxAdjustmentFactor: 1.2,
      // Whether to use reinforcement learning for scoring improvement
      useReinforcementLearning: false, // Disabled by default as it requires additional setup
    },
    // Reduced minimum requirements to catch newer trending tokens
    minimumRequirements: {
      holders: 2, // Further reduced minimum holders
      liquidityUsd: 100, // Further reduced minimum liquidity
      volumeUsd: 200, // Further reduced minimum volume
      txCount: 8, // Minimum transaction count
      uniqueBuyers: 3, // Minimum unique buyers
    },
    // Enhanced bonus factors for trending characteristics
    bonusFactors: {
      newToken: 0.30, // Further increased bonus for new tokens
      highVolatility: 0.15, // Increased bonus for volatile tokens
      trendingOnSocial: 0.35, // Further increased bonus for social trends
      rapidPriceIncrease: 0.25, // Increased bonus for rapid price increases
      increasingVolume: 0.20, // Increased bonus for increasing volume
      increasingLiquidity: 0.15, // Increased bonus for increasing liquidity
      uniqueBuyers: 0.20, // Increased bonus for having many unique buyers
      strongBuyPressure: 0.25, // New bonus for strong buy pressure
      lowMarketCap: 0.20, // New bonus for low market cap tokens
      positiveChartPattern: 0.15, // New bonus for positive chart patterns
      communityGrowth: 0.20, // New bonus for growing community
      developerActivity: 0.10, // New bonus for active development
    },
    // Penalty factors for negative characteristics
    penaltyFactors: {
      lowLiquidity: -0.15, // Penalty for very low liquidity
      suspiciousTransactionPattern: -0.25, // Penalty for suspicious transaction patterns
      highSellerConcentration: -0.20, // Penalty for high seller concentration
      negativeChartPattern: -0.15, // Penalty for negative chart patterns
      potentialRugPull: -0.50, // Severe penalty for potential rug pull indicators
      honeypotCharacteristics: -0.50, // Severe penalty for honeypot characteristics
      excessiveTokenomics: -0.20, // Penalty for excessive tokenomics (e.g., high tax)
    },
    // Trending meme coin specific scoring adjustments
    trendingMemeCoins: {
      // Additional weight for trending meme coins
      additionalWeight: 0.30, // Further increased from previous value
      // Comprehensive keywords in token name or symbol that indicate a potential trending meme coin
      keywords: [
        // Generic meme terms
        'meme', 'coin', 'moon', 'pump', 'gem', 'based', 'chad', 'wojak', 'pepe', 'frog', 'kek', 'lol',
        // Animal themes (popular in meme coins)
        'cat', 'dog', 'doge', 'shib', 'inu', 'bull', 'bear', 'ape', 'monkey', 'frog', 'toad', 'fish', 'bird', 'fox', 'panda', 'lion',
        // Internet culture references
        'ai', 'gpt', 'elon', 'musk', 'trump', 'biden', 'wojak', 'chad', 'karen', 'sigma', 'alpha', 'beta', 'gigachad', 'npc',
        // Solana ecosystem specific
        'sol', 'bonk', 'wif', 'samo', 'cope', 'bong', 'dust', 'wen', 'giga', 'orca', 'ray', 'pyth', 'jup', 'jito',
        // Trending themes
        'x', 'meta', 'vr', 'ar', 'web3', 'dao', 'defi', 'nft', 'punk', 'game', 'play', 'earn', 'metaverse',
        // Viral/meme references
        'pepe', 'dank', 'stonk', 'hodl', 'fomo', 'yolo', 'wagmi', 'ngmi', 'gm', 'gn', 'lfg', 'btfd', 'rekt',
        // Emoji references in names
        'ud83dude80', 'ud83cudf19', 'ud83cudf15', 'ud83dudc8e', 'ud83dude4c', 'ud83dudd25', 'ud83dudcb0', 'ud83dudc36', 'ud83dudc31', 'ud83dudc38', 'ud83eudd8a', 'ud83eudd81', 'ud83dudc3b', 'ud83dudc3c',
        // Current year trends
        'turbo', 'hyper', 'mega', 'ultra', 'super', 'epic', 'based', 'sigma', 'alpha', 'chad', 'king', 'queen',
        // Numeric references
        'x10', 'x100', '1000x', '420', '69', '999', '888', '777', '666', '100k', '1m',
        // Prefix/suffix patterns
        'baby', 'mini', 'little', 'big', 'mega', 'giga', 'ultra', 'super', 'hyper', 'turbo', 'pro', 'max', 'plus', 'premium',
      ],
      // Minimum price change percentage to consider a meme coin as trending
      minPriceChangePercentage: 8, // Reduced to catch more potential trends
      // Minimum volume increase percentage to consider a meme coin as trending
      minVolumeIncreasePercentage: 15, // Further reduced to catch more potential trends
      // Whether to prioritize trending meme coins in trading decisions
      prioritizeInTrading: true,
      // Maximum age of a token to be considered a new trend (in hours)
      maxTokenAgeHours: 36,
      // Minimum transaction count in the last hour
      minTransactionsLastHour: 8,
      // Minimum unique buyers in the last hour
      minUniqueBuyersLastHour: 4,
      // Exclude established meme coins to focus on new trends
      excludeEstablishedCoins: [
        'BONK', 'WIF', 'SAMO', 'MEME', 'JUP', 'PYTH', 'RAY', 'ORCA',
        'BORK', 'POPCAT', 'SLERF', 'SLOTH', 'NOPE', 'TOAD'
      ],
      // Minimum social media mentions to consider as trending
      minSocialMentions: 3,
      // Minimum positive sentiment ratio on social media
      minPositiveSentimentRatio: 0.55,
      // Advanced trend detection
      advancedTrendDetection: {
        // Whether to use pattern recognition for trend detection
        usePatternRecognition: true,
        // Whether to analyze token name trends
        analyzeNameTrends: true,
        // Whether to detect viral potential
        detectViralPotential: true,
        // Whether to analyze meme quality
        analyzeMemeQuality: true,
        // Whether to detect early whale accumulation
        detectWhaleAccumulation: true,
        // Whether to analyze community engagement quality
        analyzeCommunityQuality: true,
        // Whether to detect coordinated marketing campaigns
        detectCoordinatedMarketing: true,
      },
    },
    // Real-time scoring adjustments
    realTimeAdjustments: {
      enabled: true,
      // Adjustment interval in milliseconds
      adjustmentIntervalMs: 10000,
      // Maximum score boost for real-time factors
      maxScoreBoost: 0.2,
      // Maximum score penalty for real-time factors
      maxScorePenalty: 0.3,
      // Factors that trigger real-time adjustments
      adjustmentTriggers: {
        // Sudden price movement
        suddenPriceMovement: true,
        // Sudden volume spike
        suddenVolumeSurge: true,
        // Rapid increase in social mentions
        rapidSocialMentions: true,
        // Sudden increase in unique buyers
        suddenBuyerIncrease: true,
        // Whale transactions
        whaleTransactions: true,
      },
    },
  },
};