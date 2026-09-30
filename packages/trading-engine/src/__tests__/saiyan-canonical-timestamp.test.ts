import { ICandle } from '@quant/shared';
import { SignalGenerator } from '../signal-generator';

/**
 * Regression: SAIYAN_OCC signals had no canonicalCandleTime / canonicalDecisionTime, so the algo-bot
 * pipeline rejected every Saiyan signal (CANONICAL_TIMESTAMP_INVALID) and Saiyan bots never traded.
 * The signal must be stamped with its crossover candle's CLOSE time, never later than the decision time.
 */
describe('Saiyan OCC signals carry canonical timestamps', () => {
  const BAR = 15 * 60 * 1000;
  const start = Date.UTC(2026, 8, 29, 0, 0, 0);

  const candles = (): ICandle[] => {
    const out: ICandle[] = [];
    for (let i = 0; i < 160; i++) {
      // Down-trend then sharp up-trend so a bullish open/close crossover forms near the end
      const base = i < 120 ? 84000 - i * 20 : 84000 - 120 * 20 + (i - 120) * 60;
      out.push({
        timestamp: new Date(start + i * BAR),
        open: base,
        high: base + 40,
        low: base - 40,
        close: base + (i < 120 ? -15 : 30),
        volume: 10,
        isClosed: true,
      } as any);
    }
    return out;
  };

  it('stamps the crossover candle close time as canonicalCandleTime (and equal decision time)', () => {
    const execCandles = candles();
    const signal = SignalGenerator.generateSignal({
      symbol: 'BTCUSDT_SPOT',
      executionCandles: execCandles,
      executionTimeframe: '15m',
      strategyMode: 'SAIYAN_OCC',
      minimumCandles: 50,
    });

    expect(typeof signal.canonicalCandleTime).toBe('number');
    expect(signal.canonicalDecisionTime).toBeInstanceOf(Date);
    // The bot pipeline requires these two to be identical
    expect(signal.canonicalCandleTime).toBe((signal.canonicalDecisionTime as Date).getTime());

    const crossoverOpen = new Date(signal.timestamp as any).getTime();
    const lastClose = new Date(execCandles[execCandles.length - 1].timestamp as any).getTime() + BAR;
    // Crossover candle close (open + one bar), capped at the decision boundary
    expect(signal.canonicalCandleTime).toBe(Math.min(crossoverOpen + BAR, lastClose));
    expect(signal.canonicalCandleTime!).toBeLessThanOrEqual(lastClose);
  });

  it('floors the BTC stop at 0.5% of price so round-trip fees (~0.2%) cost well under 0.5R', () => {
    const signal = SignalGenerator.generateSignal({
      symbol: 'BTCUSDT_SPOT',
      executionCandles: candles(),
      executionTimeframe: '15m',
      strategyMode: 'SAIYAN_OCC',
      minimumCandles: 50,
    });
    const entry = signal.entryZone.optimal;
    const riskPct = Math.abs(entry - signal.stopLoss) / entry;
    expect(riskPct).toBeGreaterThanOrEqual(0.005 - 1e-6);
    expect(riskPct).toBeLessThanOrEqual(0.02 + 1e-6);
    // Round-trip fees of 0.2% of notional measured in R
    expect(0.002 / riskPct).toBeLessThanOrEqual(0.4 + 1e-6);
  });
});
