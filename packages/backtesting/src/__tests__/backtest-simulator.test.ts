import { BacktestSimulator } from '../backtest-simulator';
import { FillModel } from '../execution';
import { Direction, MockMarketDataProvider, PointInTimeCurrencyConverter, Timeframe } from '@quant/shared';

describe('BacktestSimulator', () => {
  it('should run a deterministic candle-by-candle simulation on historical candles', async () => {
    const provider = new MockMarketDataProvider({ seed: 42 });
    const candles = await provider.getHistoricalCandles('NIFTY', '15m', 250);

    const result = BacktestSimulator.runSimulation({
      symbol: 'NIFTY',
      timeframe: Timeframe.M15,
      candles,
      initialCapital: 100000,
      riskPerTradePercent: 1.0,
      minScore: 60,
    });

    expect(result).toBeDefined();
    expect(result.symbol).toBe('NIFTY');
    expect(result.initialCapital).toBe(100000);
    expect(result.finalEquity).toBeGreaterThan(0);
    expect(result.equityCurve.length).toBeGreaterThanOrEqual(1);
  });

  it('Strictly fails closed when cross-currency FX rate is missing during backtest mark-to-market', () => {
    const converter = PointInTimeCurrencyConverter.getInstance();
    converter.clearAllRates(); // Ensure NO USDT/INR rates exist

    const t0 = 1700000000000;
    const interval = 15 * 60 * 1000;
    const candles: any[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push({
        timestamp: new Date(t0 + i * interval),
        open: 100.0,
        high: 100.5,
        low: 99.5,
        close: 100.0,
        volume: 1000,
      });
    }
    candles.push({ timestamp: new Date(t0 + 30 * interval), open: 100.0, high: 100.5, low: 99.5, close: 100.0, volume: 1000 });
    candles.push({ timestamp: new Date(t0 + 31 * interval), open: 100.0, high: 100.8, low: 99.8, close: 100.2, volume: 1000 });
    candles.push({ timestamp: new Date(t0 + 32 * interval), open: 100.2, high: 106.0, low: 100.0, close: 105.5, volume: 1000 });
    candles.push({ timestamp: new Date(t0 + 33 * interval), open: 105.5, high: 105.5, low: 99.0, close: 99.2, volume: 1000 });
    candles.push({ timestamp: new Date(t0 + 34 * interval), open: 99.2, high: 100.0, low: 99.0, close: 99.5, volume: 1000 });

    // Running BTCUSDT backtest without registered USDT/INR rates MUST throw MISSING_FX_RATE
    // It must NEVER default to 1.0 (treating 1 USDT = 1 INR)
    expect(() => {
      BacktestSimulator.runSimulation({
        symbol: 'BTCUSDT',
        timeframe: '15m' as any,
        initialCapital: 100000,
        candles,
        warmupBars: 30,
        minimumCandles: 30,
        strategyMode: 'SMC',
        strategyConfig: {
          deterministicSignals: [
            {
              id: 'sig_btcusdt_test',
              symbol: 'BTCUSDT',
              direction: 'BULLISH',
              score: 85,
              entryPrice: 100.0,
              stopLoss: 95.0,
              tp1: 105.0,
              tp2: 110.0,
              tp3: 115.0,
              timestamp: new Date(t0 + 30 * interval),
            },
          ],
        },
        partialExitPolicy: {
          tp1Ratio: 0.5,
          tp2Ratio: 0.5,
          tp3Ratio: 0.0,
          moveStopToBreakevenOnTp1: true,
          trailStopOnTp2: false,
          autoDeriveTargets: true,
        },
        fillModel: FillModel.OHLC_PATH,
      });
    }).toThrow(/MISSING_FX_RATE/);
  });

  it('Correctly uses registered point-in-time FX rates for cross-currency BTCUSDT backtest', () => {
    const converter = PointInTimeCurrencyConverter.getInstance();
    converter.resetRates();
    converter.registerRate({
      pair: 'USDT/INR',
      rate: 92.0,
      timestamp: 0,
      source: 'TEST_BINANCE',
      version: '1.0',
    });

    const t0 = 1700000000000;
    const interval = 15 * 60 * 1000;
    const candles: any[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push({
        timestamp: new Date(t0 + i * interval),
        open: 100.0,
        high: 100.5,
        low: 99.5,
        close: 100.0,
        volume: 1000,
      });
    }
    candles.push({ timestamp: new Date(t0 + 30 * interval), open: 100.0, high: 100.5, low: 99.5, close: 100.0, volume: 1000 });
    candles.push({ timestamp: new Date(t0 + 31 * interval), open: 100.0, high: 100.8, low: 99.8, close: 100.2, volume: 1000 });
    candles.push({ timestamp: new Date(t0 + 32 * interval), open: 100.2, high: 106.0, low: 100.0, close: 105.5, volume: 1000 });
    candles.push({ timestamp: new Date(t0 + 33 * interval), open: 105.5, high: 105.5, low: 99.0, close: 99.2, volume: 1000 });
    candles.push({ timestamp: new Date(t0 + 34 * interval), open: 99.2, high: 100.0, low: 99.0, close: 99.5, volume: 1000 });

    const result = BacktestSimulator.runSimulation({
      symbol: 'BTCUSDT',
      timeframe: '15m' as any,
      initialCapital: 100000,
      candles,
      warmupBars: 30,
      minimumCandles: 30,
      strategyMode: 'SMC',
      strategyConfig: {
        deterministicSignals: [
          {
            id: 'sig_btcusdt_test',
            symbol: 'BTCUSDT',
            direction: 'BULLISH',
            score: 85,
            entryPrice: 100.0,
            stopLoss: 95.0,
            tp1: 105.0,
            tp2: 110.0,
            tp3: 115.0,
            timestamp: new Date(t0 + 30 * interval),
          },
        ],
      },
      fillModel: FillModel.OHLC_PATH,
    });

    expect(result).toBeDefined();
    expect(result.symbol).toBe('BTCUSDT');
    expect(result.equityCurve.length).toBeGreaterThan(0);
  });

  afterEach(() => {
    PointInTimeCurrencyConverter.getInstance().resetRates();
  });
});
