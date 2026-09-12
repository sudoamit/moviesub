import { createHash } from 'crypto';
import {
  CurrencyCode,
  IFxConversionResult,
  IResolvedMarginModel,
  ITradeAccountingSnapshot,
} from '../interfaces';

export interface IFxRateRecord {
  pair: string; // e.g. "USDT/INR", "USD/INR"
  rate: number;
  timestamp: number;
  source: string;
  version: string;
}

export interface IFxOptions {
  source?: string;
  version?: string;
  allowExactOrEarlier?: boolean;
}

export interface ICurrencyConverter {
  convert(
    amount: number,
    fromCurrency: CurrencyCode,
    toCurrency: CurrencyCode,
    timestamp: number,
    options?: IFxOptions,
  ): IFxConversionResult;
  getRate(
    fromCurrency: CurrencyCode,
    toCurrency: CurrencyCode,
    timestamp: number,
    options?: IFxOptions,
  ): IFxConversionResult;
}

export class PointInTimeCurrencyConverter implements ICurrencyConverter {
  private static instance?: PointInTimeCurrencyConverter;
  private readonly rateHistory: Map<string, IFxRateRecord[]> = new Map();

  constructor() {
    this.seedDefaultRates();
  }

  public static getInstance(): PointInTimeCurrencyConverter {
    if (!this.instance) {
      this.instance = new PointInTimeCurrencyConverter();
    }
    return this.instance;
  }

  public static resetInstance(): void {
    this.instance = undefined;
  }

  /**
   * Registers a point-in-time FX rate for a currency pair.
   */
  public registerRate(record: IFxRateRecord): void {
    if (!record || typeof record.rate !== 'number' || !Number.isFinite(record.rate) || record.rate <= 0) {
      throw new Error(`INVALID_FX_RATE: Rate must be a positive finite number, got ${record?.rate}`);
    }
    const pairKey = this.normalizePair(record.pair);
    const existing = this.rateHistory.get(pairKey) || [];
    existing.push({
      ...record,
      pair: pairKey,
    });
    // Keep sorted by timestamp ascending
    existing.sort((a, b) => a.timestamp - b.timestamp);
    this.rateHistory.set(pairKey, existing);
  }

  /**
   * Clears all registered rates and reseeds default rates.
   */
  public resetRates(): void {
    this.rateHistory.clear();
    this.seedDefaultRates();
  }

  /**
   * Clears all registered rates without reseeding (used for strict fail-closed testing).
   */
  public clearAllRates(): void {
    this.rateHistory.clear();
  }

  /**
   * Authoritatively converts amount from fromCurrency to toCurrency at asOfTimestamp.
   * STRICT FAIL-CLOSED: If fromCurrency !== toCurrency and no rate is found, throws MISSING_FX_RATE.
   */
  public convert(
    amount: number,
    fromCurrency: CurrencyCode,
    toCurrency: CurrencyCode,
    timestamp: number,
    options?: IFxOptions,
  ): IFxConversionResult {
    const fxInfo = this.getRate(fromCurrency, toCurrency, timestamp, options);
    const convertedAmount = Number((amount * fxInfo.fxRate).toFixed(4));
    return {
      ...fxInfo,
      originalAmount: amount,
      convertedAmount,
    };
  }

  /**
   * Resolves point-in-time rate and cryptographic audit snapshot hash.
   */
  public getRate(
    fromCurrency: CurrencyCode,
    toCurrency: CurrencyCode,
    timestamp: number,
    options?: IFxOptions,
  ): IFxConversionResult {
    const from = (fromCurrency || 'INR').toUpperCase();
    const to = (toCurrency || 'INR').toUpperCase();

    if (from === to) {
      const snapshotHash = createHash('sha256')
        .update(`${from}:${to}:1.0:${timestamp}:identity:v1.0`)
        .digest('hex');
      return {
        originalAmount: 1,
        convertedAmount: 1,
        fromCurrency: from,
        toCurrency: to,
        fxPair: `${from}/${to}`,
        fxRate: 1.0,
        fxTimestamp: timestamp,
        fxSource: 'IDENTITY',
        fxVersion: '1.0',
        fxSnapshotHash: snapshotHash,
      };
    }

    const pairKey = `${from}/${to}`;
    const inversePairKey = `${to}/${from}`;

    const records = this.rateHistory.get(pairKey);
    if (records && records.length > 0) {
      // Find latest record where record.timestamp <= timestamp (Point-in-time, zero lookahead)
      const valid = records.filter((r) => r.timestamp <= timestamp);
      if (valid.length > 0) {
        const selected = valid[valid.length - 1];
        const snapshotHash = createHash('sha256')
          .update(`${from}:${to}:${selected.rate}:${selected.timestamp}:${selected.source}:${selected.version}`)
          .digest('hex');
        return {
          originalAmount: 1,
          convertedAmount: selected.rate,
          fromCurrency: from,
          toCurrency: to,
          fxPair: pairKey,
          fxRate: selected.rate,
          fxTimestamp: selected.timestamp,
          fxSource: selected.source,
          fxVersion: selected.version,
          fxSnapshotHash: snapshotHash,
        };
      }
    }

    // Check inverse pair (e.g. INR/USDT -> 1 / USDT/INR)
    const invRecords = this.rateHistory.get(inversePairKey);
    if (invRecords && invRecords.length > 0) {
      const valid = invRecords.filter((r) => r.timestamp <= timestamp);
      if (valid.length > 0) {
        const selected = valid[valid.length - 1];
        const invRate = Number((1.0 / selected.rate).toFixed(6));
        const snapshotHash = createHash('sha256')
          .update(`${from}:${to}:${invRate}:${selected.timestamp}:${selected.source}:${selected.version}:inverted`)
          .digest('hex');
        return {
          originalAmount: 1,
          convertedAmount: invRate,
          fromCurrency: from,
          toCurrency: to,
          fxPair: pairKey,
          fxRate: invRate,
          fxTimestamp: selected.timestamp,
          fxSource: `${selected.source}_INVERTED`,
          fxVersion: selected.version,
          fxSnapshotHash: snapshotHash,
        };
      }
    }

    // STRICT FAIL-CLOSED: No silent 1:1 fallback for cross-currency
    throw new Error(
      `MISSING_FX_RATE: No point-in-time FX rate found for pair '${pairKey}' at timestamp ${timestamp} (${new Date(timestamp).toISOString()}). Cross-currency operations fail closed.`,
    );
  }

  private normalizePair(pair: string): string {
    const cleaned = pair.replace(/[-_]/g, '/').toUpperCase();
    if (cleaned.includes('/')) return cleaned;
    if (cleaned === 'USDTINR') return 'USDT/INR';
    if (cleaned === 'USDINR') return 'USD/INR';
    if (cleaned === 'EURINR') return 'EUR/INR';
    if (cleaned === 'BTCUSDT') return 'BTC/USDT';
    return cleaned;
  }

  private seedDefaultRates(): void {
    // Default baseline rates starting from early timestamps
    const baseTime = 0; // Epoch start for baseline availability
    this.registerRate({
      pair: 'USDT/INR',
      rate: 92.0,
      timestamp: baseTime,
      source: 'RBI_MARKET_BASELINE',
      version: '1.0',
    });
    this.registerRate({
      pair: 'USD/INR',
      rate: 87.0,
      timestamp: baseTime,
      source: 'RBI_MARKET_BASELINE',
      version: '1.0',
    });
    this.registerRate({
      pair: 'EUR/INR',
      rate: 95.0,
      timestamp: baseTime,
      source: 'RBI_MARKET_BASELINE',
      version: '1.0',
    });
  }
}

/**
 * Computes a deterministic SHA-256 cryptographic hash over all immutable trade accounting parameters.
 */
export function computeAccountingSnapshotHash(params: {
  accountCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
  fxPair: string;
  fxRate: number;
  fxTimestamp: number;
  fxSource: string;
  fxSnapshotHash: string;
  contractSize: number;
  lotSize: number;
  resolvedMarginModel: IResolvedMarginModel;
  calculatedAt: number;
}): string {
  const payload = [
    params.accountCurrency,
    params.quoteCurrency,
    params.fxPair,
    Number(params.fxRate).toFixed(6),
    params.fxTimestamp,
    params.fxSource,
    params.fxSnapshotHash,
    params.contractSize,
    params.lotSize,
    params.resolvedMarginModel.marginMode,
    params.resolvedMarginModel.effectiveLeverage,
    Number(params.resolvedMarginModel.initialMarginRate).toFixed(4),
    Number(params.resolvedMarginModel.maintenanceMarginRate).toFixed(4),
    params.resolvedMarginModel.liquidationModel,
    params.calculatedAt,
  ].join(':');

  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Builds an immutable, verifiable ITradeAccountingSnapshot coupling FX provenance, contract sizing, and margin models.
 */
export function buildAccountingSnapshot(params: {
  accountCurrency: CurrencyCode;
  quoteCurrency: CurrencyCode;
  fxResult: IFxConversionResult;
  contractSize: number;
  lotSize: number;
  resolvedMarginModel: IResolvedMarginModel;
  calculatedAt?: number;
}): ITradeAccountingSnapshot {
  const calcTime = params.calculatedAt ?? params.fxResult.fxTimestamp;
  const snapshotData = {
    accountCurrency: params.accountCurrency,
    quoteCurrency: params.quoteCurrency,
    fxPair: params.fxResult.fxPair,
    fxRate: params.fxResult.fxRate,
    fxTimestamp: params.fxResult.fxTimestamp,
    fxSource: params.fxResult.fxSource,
    fxSnapshotHash: params.fxResult.fxSnapshotHash,
    contractSize: params.contractSize,
    lotSize: params.lotSize,
    resolvedMarginModel: params.resolvedMarginModel,
    calculatedAt: calcTime,
  };

  const snapshotHash = computeAccountingSnapshotHash(snapshotData);

  return {
    ...snapshotData,
    snapshotHash,
  };
}
