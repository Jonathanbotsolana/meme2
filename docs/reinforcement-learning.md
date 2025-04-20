# Reinforcement Learning Module

The Reinforcement Learning (RL) module in Kairos Meme Bot tracks rejected tokens and learns from missed opportunities to improve future trading decisions.

## How It Works

1. **Token Rejection Tracking**:
   - When a token is rejected for trading, it's added to the `rejected_tokens` table
   - The system records the rejection reason, price, and scoring metrics

2. **Price Monitoring**:
   - Rejected tokens are monitored for price changes at 5m, 1h, and 24h intervals
   - Price data is fetched from Jupiter or CoinGecko APIs

3. **Missed Opportunity Detection**:
   - If a token's price increases by 2x or more within 1 hour of rejection, it's marked as a missed opportunity
   - The system records the highest price reached and percentage increase

4. **Weight Adjustment**:
   - When missed opportunities are detected, the system adjusts scoring weights
   - Weights are adjusted based on the rejection reason (e.g., if rejected for low sentiment score but price increased, sentiment weight is reduced)
   - A learning rate parameter controls how quickly weights are adjusted

5. **Persistence**:
   - Current weights are stored in the database and exported to `weights.json`
   - This allows for easy inspection and manual adjustment if needed

## CLI Usage

The RL module includes a command-line interface for viewing statistics and managing the system:

```bash
node src/cli/rl-stats.js [options]
```

Options:
- `-h, --help`: Show help message
- `-u, --update`: Update prices for tracked tokens before showing stats
- `-r, --reset`: Reset weights to default values

## Scheduled Updates

To keep price tracking accurate, you should schedule regular updates:

```bash
# Run every 5 minutes
*/5 * * * * cd /path/to/kairos-meme-bot && node src/tasks/update-rejected-tokens.js >> logs/rl-updates.log 2>&1
```

## Statistics

The RL module tracks and reports:

- Total rejected tokens
- Number of missed opportunities
- Accuracy percentage (correct rejections vs. missed opportunities)
- Average missed gain percentage
- Current scoring weights

## Integration

The RL module is automatically integrated with the token evaluation process. When tokens are rejected, they're automatically tracked, and the system learns over time to improve decision-making.

## Manual Weight Adjustment

If you want to manually adjust weights, you can edit the `weights.json` file or use the database directly:

```sql
UPDATE scoring_weights SET weight_value = 0.75 WHERE weight_name = 'sentiment_score_weight';
```

After manual adjustments, run the following to update the weights file:

```javascript
const database = require('./src/utils/database');
database.saveWeightsToFile();
```