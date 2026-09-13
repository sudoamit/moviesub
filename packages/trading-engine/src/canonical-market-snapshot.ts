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

    if (provenance === 'SYNTHETIC' && options.allowSyntheticInProduction !== true) {
      // In live analytical context, synthetic candles cannot trigger confirmed production signals
    }

    // 1. Partition into confirmed closed candles and forming candle
    const { closedCandles, formingCandle } = CandleNormalizer.partitionCandles(rawCandles, {
      asOfTimestamp: options.asOfTimestamp,
      timeframe,
    });

    // 2. Determine closedThroughTimestamp & decisionTimestamp
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

    // 3. Gap Detection on confirmed closed candles
    const rawGaps = CandleNormalizer.detectGaps(closedCandles, timeframe);
    const gapStatus = rawGaps.length > 0 ? 'DETECTED' : 'NONE';
    const gapDetails: IDataGapDetail[] = rawGaps.map((g) => ({
      expectedTime: g.expectedTime,
      actualTime: g.actualTime,
      missingCount: g.missingCount,
    }));

    // 4. Resolve Authoritative Instrument
    let instrument: IInstrument;
    try {
      instrument = getAuthoritativeInstrument(symbol);
    } catch {
      instrument = {
        id: `inst-${symbol.toLowerCase()}`,
        symbol,
        name: symbol,
        exchange: 'NSE',
        assetType: 'EQUITY' as any,
        currency: 'INR' as any,
        lotSize: 1,
        tickSize: 0.05,
        contractSize: 1,
        isActive: true,
      };
    }

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
