import { ExecutionPriceResolver } from '../execution-price-resolver';
import { ExecutionPriceSource, TradingMode } from '../../enums';
import { MarketDataUnavailableError, StaleMarketDataError } from '../../errors';

describe('ExecutionPriceResolver', () => {
  it('should resolve fresh live tick with LIVE_TICK source tag', async () => {
    const tickTime = new Date(Date.now() - 1000);
    const result = await ExecutionPriceResolver.resolveExecutionPrice({
      symbol: 'BTCUSDT',
      tradingMode: TradingMode.PAPER,
      maxMarketDataAgeSeconds: 5,
      liveTick: {
        price: 88500.5,
        timestamp: tickTime,
      },
    });

    expect(result.price).toBe(88500.5);
    expect(result.marketPrice).toBe(88500.5);
    expect(result.source).toBe(ExecutionPriceSource.LIVE_TICK);
    expect(result.sourceTimestamp).toEqual(tickTime);
    expect(result.ageSeconds).toBeLessThanOrEqual(5);
  });

  it('should reject execution in PAPER mode if live tick is missing even if a candle is available (zero candle fallback)', async () => {
    await expect(
      ExecutionPriceResolver.resolveExecutionPrice({
        symbol: 'NIFTY',
        tradingMode: TradingMode.PAPER,
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
      }),
    ).rejects.toThrow(MarketDataUnavailableError);
  });

  it('should throw StaleMarketDataError if market tick exceeds max age threshold in PAPER mode', async () => {
    await expect(
      ExecutionPriceResolver.resolveExecutionPrice({
        symbol: 'BANKNIFTY',
        tradingMode: TradingMode.PAPER,
        maxMarketDataAgeSeconds: 5,
        liveTick: {
          price: 52000,
          timestamp: new Date(Date.now() - 10000), // 10 seconds ago
        },
      }),
    ).rejects.toThrow(StaleMarketDataError);
  });

  it('should reject live tick if timestamp is far in the future (> 5s clock skew)', async () => {
    await expect(
      ExecutionPriceResolver.resolveExecutionPrice({
        symbol: 'BANKNIFTY',
        tradingMode: TradingMode.PAPER,
        maxMarketDataAgeSeconds: 5,
        liveTick: {
          price: 52000,
          timestamp: new Date(Date.now() + 60000), // 1 minute in the future
        },
      }),
    ).rejects.toThrow(MarketDataUnavailableError);
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
    expect(result.marketPrice).toBe(24050);
    expect(result.source).toBe(ExecutionPriceSource.BACKTEST_CANDLE);
  });

  describe('calculateSlippage', () => {
    it('BUY: fill price >= reference price (reference: 100, slippage: 10 bps -> fill: 100.10)', () => {
      const buySlip = ExecutionPriceResolver.calculateSlippage(100, 'BUY', 50, 10);
      expect(buySlip.slippageBps).toBe(10);
      expect(buySlip.fillPrice).toBe(100.1);
      expect(buySlip.slippageAmount).toBe(0.1);
      expect(buySlip.fillPrice).toBeGreaterThanOrEqual(100);
    });

    it('SELL: fill price <= reference price (reference: 100, slippage: 10 bps -> fill: 99.90)', () => {
      const sellSlip = ExecutionPriceResolver.calculateSlippage(100, 'SELL', 50, 10);
      expect(sellSlip.slippageBps).toBe(10);
      expect(sellSlip.fillPrice).toBe(99.9);
      expect(sellSlip.slippageAmount).toBe(0.1);
      expect(sellSlip.fillPrice).toBeLessThanOrEqual(100);
    });

    it('Zero slippage: fill price equals reference price', () => {
      const zeroSlip = ExecutionPriceResolver.calculateSlippage(100, 'BUY', 0);
      expect(zeroSlip.slippageBps).toBe(0);
      expect(zeroSlip.fillPrice).toBe(100);
      expect(zeroSlip.slippageAmount).toBe(0);
    });

    it('Maximum configured slippage: slippage never exceeds maxSlippageBps', () => {
      const maxSlip = ExecutionPriceResolver.calculateSlippage(100, 'BUY', 20, 100);
      expect(maxSlip.slippageBps).toBe(20);
      expect(maxSlip.fillPrice).toBe(100.2);
    });
  });
});
