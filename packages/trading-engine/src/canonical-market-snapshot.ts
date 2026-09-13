import {
  ICandle,
  IInstrument,
  ITradeAccountingSnapshot,
  Timeframe,
  getAuthoritativeInstrument,
} from '@quant/shared';
import { CandleNormalizer } from './candle-normalizer';

export type MarketDataProvenance = 'LIVE' | 'BACKTEST' | 'SYNTHETIC' | 'HISTORICAL' | 'CACHED';

export interface IDataGapDetail {
  expectedTime: Date;
  actualTime: Date;
  missingCount: number;
}

export interface ICanonicalMarketSnapshot {
  readonly symbol: string;
  readonly executionTimeframe: Timeframe | string;
  readonly decisionTimestamp: Date;
  readonly closedThroughTimestamp: Date;
  readonly candles: readonly ICandle[];
  readonly formingCandle: ICandle | null;
  readonly dataProvenance: MarketDataProvenance;
  readonly gapStatus: 'NONE' | 'DETECTED';
  readonly gapDetails: readonly IDataGapDetail[];
  readonly instrument: IInstrument;
  readonly accountingSnapshot?: ITradeAccountingSnapshot;
  readonly isImmutable: boolean;
}

export interface ICreateSnapshotOptions {
  symbol: string;
  executionCandles: ICandle[];
  executionTimeframe?: Timeframe | string;
  asOfTimestamp?: Date;
  dataProvenance?: MarketDataProvenance;
  accountingSnapshot?: ITradeAccountingSnapshot;
  allowSyntheticInProduction?: boolean;
}

export class CanonicalMarketSnapshotBuilder {
  /**
   * Constructs an immutable, point-in-time Canonical Market Snapshot.
   * Confirmed analytical candles strictly exclude forming / unclosed bars.
   * Synthetic candles are rejected if attempted in production live analytical context.
   */
  static build(options: ICreateSnapshotOptions): ICanonicalMarketSnapshot {
    const symbol = options.symbol.toUpperCase();
    const timeframe = options.executionTimeframe || Timeframe.M15;
    const rawCandles = options.executionCandles || [];
    const provenance = options.dataProvenance || (rawCandles.length > 0 && rawCandles[0].provenance as MarketDataProvenance) || 'LIVE';

    // 1. Synthetic Market Data Policy Enforcement
    if (provenance === 'SYNTHETIC' && options.allowSyntheticInProduction !== true) {
      throw new Error(
        `[SNAPSHOT FAIL-CLOSED] Synthetic market data is strictly prohibited in production analytical contexts for '${symbol}'. Explicitly specify allowSyntheticInProduction: true for backtests or unit tests.`,
      );
    }

    if (
      provenance === 'LIVE' &&
      rawCandles.some((c: any) => c.isSynthetic === true || c.provenance === 'SYNTHETIC')
    ) {
      throw new Error(
        `[SNAPSHOT FAIL-CLOSED] Synthetic candle detected within LIVE market data stream for '${symbol}'. Snapshot construction aborted to fail closed.`,
      );
    }

    // 2. Resolve Authoritative Instrument with Strict Fail-Closed Validation
    let instrument: IInstrument;
    try {
      instrument = getAuthoritativeInstrument(symbol);
    } catch (err: any) {
      throw new Error(
        `[SNAPSHOT FAIL-CLOSED] Unknown or unregistered symbol: '${symbol}'. Cannot construct canonical market snapshot without authoritative instrument definition. Cause: ${err?.message || err}`,
      );
    }

    if (instrument.isActive === false) {
      throw new Error(
        `[SNAPSHOT FAIL-CLOSED] Instrument '${symbol}' is marked inactive. Cannot construct canonical market snapshot for inactive instrument.`,
      );
    }

    if (
      !instrument.lotSize ||
      instrument.lotSize <= 0 ||
      !instrument.tickSize ||
      instrument.tickSize <= 0 ||
      !instrument.currency
    ) {
      throw new Error(
        `[SNAPSHOT FAIL-CLOSED] Instrument '${symbol}' has invalid accounting metadata (lotSize: ${instrument.lotSize}, tickSize: ${instrument.tickSize}, currency: ${instrument.currency}).`,
      );
    }

    // 3. Partition into confirmed closed candles and forming candle
    const { closedCandles, formingCandle } = CandleNormalizer.partitionCandles(rawCandles, {
      asOfTimestamp: options.asOfTimestamp,
      timeframe,
    });

    // 4. Determine closedThroughTimestamp & decisionTimestamp
    let closedThroughTimestamp: Date;
    if (closedCandles.length > 0) {
      const lastClosed = closedCandles[closedCandles.length - 1];
      closedThroughTimestamp = CandleNormalizer.getCandleCloseTimestamp(lastClosed, timeframe);
    } else if (options.asOfTimestamp) {
      closedThroughTimestamp = new Date(options.asOfTimestamp);
    } else {
      closedThroughTimestamp = new Date();
    }

    const decisionTimestamp = options.asOfTimestamp
      ? new Date(options.asOfTimestamp)
      : closedThroughTimestamp;

    // 5. Gap Detection on confirmed closed candles
    const rawGaps = CandleNormalizer.detectGaps(closedCandles, timeframe);
    const gapStatus = rawGaps.length > 0 ? 'DETECTED' : 'NONE';
    const gapDetails: IDataGapDetail[] = rawGaps.map((g) => ({
      expectedTime: g.expectedTime,
      actualTime: g.actualTime,
      missingCount: g.missingCount,
    }));

    const snapshot: ICanonicalMarketSnapshot = Object.freeze({
      symbol,
      executionTimeframe: timeframe,
      decisionTimestamp,
      closedThroughTimestamp,
      candles: Object.freeze([...closedCandles]),
      formingCandle: formingCandle ? Object.freeze({ ...formingCandle }) : null,
      dataProvenance: provenance,
      gapStatus,
      gapDetails: Object.freeze(gapDetails),
      instrument: Object.freeze({ ...instrument }),
      accountingSnapshot: options.accountingSnapshot ? Object.freeze({ ...options.accountingSnapshot }) : undefined,
      isImmutable: true,
    });

    return snapshot;
  }
}
