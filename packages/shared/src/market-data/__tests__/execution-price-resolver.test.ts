import { ExecutionPriceResolver } from '../execution-price-resolver';
import { ExecutionPriceSource, TradingMode } from '../../enums';
import { MarketDataUnavailableError, StaleMarketDataError } from '../../errors';

describe('ExecutionPriceResolver', () => {
  it('should resolve fresh live tick with LIVE_TICK source tag', async () => {
    const result = await ExecutionPriceResolver.resolveExecutionPrice({
      symbol: 'BTCUSDT',
      maxMarketDataAgeSeconds: 5,
      liveTick: {
        price: 88500.5,
        timestamp: new Date(Date.now() - 1000), // 1 second ago
      },
    });

    expect(result.price).toBe(88500.5);
    expect(result.source).toBe(ExecutionPriceSource.LIVE_TICK);
    expect(result.ageSeconds).toBeLessThanOrEqual(5);
  });

  it('should fallback to latest candle if live tick is missing and candle is fresh', async () => {
    const result = await ExecutionPriceResolver.resolveExecutionPrice({
      symbol: 'NIFTY',
      maxMarketDataAgeSeconds: 5,
      liveTick: null,
      getLatestCandle: async () => ({
        timestamp: new Date(Date.now() - 2000), // 2 seconds ago
        open: 24500,
        high: 24520,
        low: 24490,
        close: 24510.5,
        volume: 150000,
      }),
    });

    expect(result.price).toBe(24510.5);
    expect(result.source).toBe(ExecutionPriceSource.LATEST_CANDLE);
  });

  it('should throw StaleMarketDataError if market tick exceeds max age threshold', async () => {
    await expect(
      ExecutionPriceResolver.resolveExecutionPrice({
        symbol: 'BANKNIFTY',
        maxMarketDataAgeSeconds: 5,
        liveTick: {
          price: 52000,
          timestamp: new Date(Date.now() - 10000), // 10 seconds ago
        },
      }),
    ).rejects.toThrow(StaleMarketDataError);
  });

  it('should allow historical candle in BACKTEST mode with BACKTEST_CANDLE source tag', async () => {
    const result = await ExecutionPriceResolver.resolveExecutionPrice({
      symbol: 'NIFTY',
      tradingMode: TradingMode.BACKTEST,
      getLatestCandle: async () => ({
        timestamp: new Date(Date.now() - 3600 * 1000), // 1 hour ago
        open: 24000,
        high: 24100,
        low: 23950,
        close: 24050,
        volume: 200000,
      }),
    });

    expect(result.price).toBe(24050);
    expect(result.source).toBe(ExecutionPriceSource.BACKTEST_CANDLE);
  });

  it('should calculate realistic slippage within maxSlippageBps', () => {
    const buySlip = ExecutionPriceResolver.calculateSlippage(24000, 'BUY', 50, 10);
    expect(buySlip.slippageBps).toBe(10);
    expect(buySlip.fillPrice).toBe(24024); // 24000 + 24
    expect(buySlip.slippageAmount).toBe(24);

    const sellSlip = ExecutionPriceResolver.calculateSlippage(24000, 'SELL', 50, 10);
    expect(sellSlip.slippageBps).toBe(10);
    expect(sellSlip.fillPrice).toBe(23976); // 24000 - 24
    expect(sellSlip.slippageAmount).toBe(24);
  });
});
