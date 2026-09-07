import { ExecutionPriceSource, TradingMode } from '../enums';
import { ICandle } from '../interfaces';
import { MarketDataUnavailableError, StaleMarketDataError } from '../errors';

export interface ExecutionPriceResult {
  price: number;
  source: ExecutionPriceSource;
  sourceTimestamp: Date;
  latencyMs: number;
  ageSeconds: number;
  slippageBps?: number;
  slippageAmount?: number;
}

export interface ResolveExecutionPriceOptions {
  symbol: string;
  tradingMode?: TradingMode;
  maxMarketDataAgeSeconds?: number;
  maxSlippageBps?: number;
  liveTick?: { price: number; timestamp: Date } | null;
  getLatestCandle?: () => Promise<ICandle | null> | ICandle | null;
  direction?: 'BUY' | 'SELL' | 'BULLISH' | 'BEARISH';
  simulateSlippage?: boolean;
}

export class ExecutionPriceResolver {
  public static readonly DEFAULT_MAX_DATA_AGE_SECONDS = 5;
  public static readonly DEFAULT_MAX_SLIPPAGE_BPS = 50;

  /**
   * Resolves execution price from authoritative market data sources according to trading mode.
   * - LIVE / PAPER: Strictly requires fresh live tick (LIVE_TICK) or fresh sub-threshold candle (LATEST_CANDLE).
   * - BACKTEST: Allows historical candle close with BACKTEST_CANDLE tag.
   * Fails closed by throwing MarketDataUnavailableError or StaleMarketDataError if no fresh price exists.
   */
  public static async resolveExecutionPrice(
    options: ResolveExecutionPriceOptions,
  ): Promise<ExecutionPriceResult> {
    const {
      symbol,
      tradingMode = TradingMode.PAPER,
      maxMarketDataAgeSeconds = this.DEFAULT_MAX_DATA_AGE_SECONDS,
      maxSlippageBps = this.DEFAULT_MAX_SLIPPAGE_BPS,
      liveTick,
      getLatestCandle,
      direction,
      simulateSlippage = false,
    } = options;

    const now = Date.now();

    // 1. Check Live Tick
    if (liveTick && typeof liveTick.price === 'number' && Number.isFinite(liveTick.price) && liveTick.price > 0) {
      const tickTime = liveTick.timestamp instanceof Date ? liveTick.timestamp.getTime() : new Date(liveTick.timestamp).getTime();
      const ageSeconds = Math.max(0, (now - tickTime) / 1000);

      if (ageSeconds <= maxMarketDataAgeSeconds) {
        let finalPrice = liveTick.price;
        let slippageBps = 0;
        let slippageAmount = 0;

        if (simulateSlippage && direction) {
          const slip = this.calculateSlippage(liveTick.price, direction, maxSlippageBps);
          finalPrice = slip.fillPrice;
          slippageBps = slip.slippageBps;
          slippageAmount = slip.slippageAmount;
        }

        return {
          price: finalPrice,
          source: ExecutionPriceSource.LIVE_TICK,
          sourceTimestamp: new Date(tickTime),
          latencyMs: Math.round((now - tickTime)),
          ageSeconds,
          slippageBps,
          slippageAmount,
        };
      }
    }

    // 2. Check Candle Data
    if (getLatestCandle) {
      try {
        const candle = await getLatestCandle();
        if (candle && typeof candle.close === 'number' && Number.isFinite(candle.close) && candle.close > 0) {
          const candleTime = candle.timestamp instanceof Date ? candle.timestamp.getTime() : new Date(candle.timestamp).getTime();
          const ageSeconds = Math.max(0, (now - candleTime) / 1000);

          // For BACKTEST mode, candle price is valid regardless of real-time age
          if (tradingMode === TradingMode.BACKTEST) {
            return {
              price: candle.close,
              source: ExecutionPriceSource.BACKTEST_CANDLE,
              sourceTimestamp: new Date(candleTime),
              latencyMs: 0,
              ageSeconds,
            };
          }

          // For LIVE or PAPER mode, candle must be strictly fresh
          if (ageSeconds <= maxMarketDataAgeSeconds) {
            return {
              price: candle.close,
              source: ExecutionPriceSource.LATEST_CANDLE,
              sourceTimestamp: new Date(candleTime),
              latencyMs: Math.round((now - candleTime)),
              ageSeconds,
            };
          } else {
            throw new StaleMarketDataError(
              symbol,
              ageSeconds,
              maxMarketDataAgeSeconds,
              new Date(candleTime),
            );
          }
        }
      } catch (err) {
        if (err instanceof StaleMarketDataError || err instanceof MarketDataUnavailableError) {
          throw err;
        }
        throw new MarketDataUnavailableError(
          symbol,
          `Failed to retrieve latest candle: ${(err as Error).message}`,
        );
      }
    }

    // If live tick was supplied but stale, and candle was not provided/available
    if (liveTick && liveTick.timestamp) {
      const tickTime = liveTick.timestamp instanceof Date ? liveTick.timestamp.getTime() : new Date(liveTick.timestamp).getTime();
      const ageSeconds = Math.max(0, (now - tickTime) / 1000);
      throw new StaleMarketDataError(
        symbol,
        ageSeconds,
        maxMarketDataAgeSeconds,
        new Date(tickTime),
      );
    }

    // No market data available at all
    throw new MarketDataUnavailableError(
      symbol,
      `No live tick or recent candle data found for symbol '${symbol}' in ${tradingMode} mode`,
    );
  }

  /**
   * Calculates realistic market slippage in basis points (bps) within maxSlippageBps.
   * BUY orders slip upwards (+), SELL orders slip downwards (-).
   */
  public static calculateSlippage(
    basePrice: number,
    direction: 'BUY' | 'SELL' | 'BULLISH' | 'BEARISH',
    maxSlippageBps = 50,
    fixedSlippageBps?: number,
  ): { fillPrice: number; slippageBps: number; slippageAmount: number } {
    const isBuy = direction === 'BUY' || direction === 'BULLISH';
    // Realistic slippage between 1 and min(maxSlippageBps, 15) bps by default
    const simulatedBps =
      fixedSlippageBps !== undefined
        ? Math.min(fixedSlippageBps, maxSlippageBps)
        : Math.min(maxSlippageBps, Math.max(1, Math.round(Math.random() * 8 + 2)));

    const slippageMultiplier = (simulatedBps / 10000);
    const slippageAmount = Number((basePrice * slippageMultiplier).toFixed(4));
    const fillPrice = isBuy
      ? Number((basePrice + slippageAmount).toFixed(4))
      : Number((basePrice - slippageAmount).toFixed(4));

    return {
      fillPrice,
      slippageBps: simulatedBps,
      slippageAmount,
    };
  }
}

