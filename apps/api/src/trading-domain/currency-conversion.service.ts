import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  CurrencyCode,
  FxRateSnapshot,
  ICurrencyConversionService,
  PointInTimeCurrencyConverter,
  IFxRateRecord,
} from '@quant/shared';

@Injectable()
export class CurrencyConversionService implements ICurrencyConversionService {
  private readonly logger = new Logger(CurrencyConversionService.name);

  private readonly converter: PointInTimeCurrencyConverter;

  constructor() {
    this.converter = PointInTimeCurrencyConverter.getInstance();
  }

  /**
   * Generates a deterministic cryptographic SHA-256 hash of an FX snapshot.
   */
  public generateSnapshotHash(
    sourceCurrency: string,
    targetCurrency: string,
    rate: number,
    rateTimestamp: number,
    rateSource: string,
  ): string {
    return createHash('sha256')
      .update(`${sourceCurrency}:${targetCurrency}:${rate}:${rateTimestamp}:${rateSource}`)
      .digest('hex');
  }

  /**
   * Resolves point-in-time FX rate snapshot between source and target currency.
   * STRICT FAIL-CLOSED: Rejects with BadRequestException if rate is missing.
   */
  public getRate(
    sourceCurrency: string,
    targetCurrency: string,
    timestamp: number = Date.now(),
  ): FxRateSnapshot {
    if (!sourceCurrency || !targetCurrency) {
      throw new BadRequestException(
        `[INVALID_CURRENCY_SPECIFICATION] sourceCurrency and targetCurrency must be specified. Got: source=${sourceCurrency}, target=${targetCurrency}`,
      );
    }

    const source = sourceCurrency.trim().toUpperCase();
    const target = targetCurrency.trim().toUpperCase();

    // 1. Identity conversion (e.g. INR -> INR, USDT -> USDT)
    if (source === target) {
      const snapshotHash = this.generateSnapshotHash(source, target, 1.0, timestamp, 'IDENTITY');
      return {
        sourceCurrency: source,
        targetCurrency: target,
        rate: 1.0,
        rateTimestamp: timestamp,
        rateSource: 'IDENTITY',
        pair: `${source}/${target}`,
        snapshotHash,
        version: '1.0',
      };
    }

    // 2. Query point-in-time converter
    try {
      const fxResult = this.converter.getRate(
        source as CurrencyCode,
        target as CurrencyCode,
        timestamp,
      );

      const snapshotHash = this.generateSnapshotHash(
        source,
        target,
        fxResult.fxRate,
        fxResult.fxTimestamp,
        fxResult.fxSource,
      );

      return {
        sourceCurrency: source,
        targetCurrency: target,
        rate: fxResult.fxRate,
        rateTimestamp: fxResult.fxTimestamp,
        rateSource: fxResult.fxSource,
        pair: fxResult.fxPair,
        snapshotHash,
        version: fxResult.fxVersion || '1.0',
      };
    } catch (err: any) {
      throw new BadRequestException(
        `[MISSING_FX_RATE] Failed to resolve FX rate for ${source}/${target} at timestamp ${timestamp} (${new Date(
          timestamp,
        ).toISOString()}): ${err.message}`,
      );
    }
  }

  /**
   * Converts amount from source currency to target currency at asOf timestamp.
   */
  public convert(
    amount: number,
    sourceCurrency: string,
    targetCurrency: string,
    timestamp: number = Date.now(),
  ): { convertedAmount: number; fxSnapshot: FxRateSnapshot } {
    if (!Number.isFinite(amount)) {
      throw new BadRequestException(`[INVALID_CONVERSION_AMOUNT] Amount must be finite number. Got: ${amount}`);
    }

    const fxSnapshot = this.getRate(sourceCurrency, targetCurrency, timestamp);
    const convertedAmount = Number((amount * fxSnapshot.rate).toFixed(4));

    return {
      convertedAmount,
      fxSnapshot,
    };
  }

  /**
   * Multi-leg triangulation: resolves rate from sourceCurrency to intermediateCurrency,
   * then intermediateCurrency to targetCurrency.
   * e.g., BTC -> USDT, then USDT -> INR => BTC -> INR.
   */
  public triangulateRate(
    sourceCurrency: string,
    intermediateCurrency: string,
    targetCurrency: string,
    timestamp: number = Date.now(),
  ): FxRateSnapshot {
    const leg1 = this.getRate(sourceCurrency, intermediateCurrency, timestamp);
    const leg2 = this.getRate(intermediateCurrency, targetCurrency, timestamp);

    const combinedRate = Number((leg1.rate * leg2.rate).toFixed(6));
    const effectiveTimestamp = Math.min(leg1.rateTimestamp, leg2.rateTimestamp);
    const combinedSource = `${leg1.rateSource}*${leg2.rateSource}`;
    const pair = `${sourceCurrency.toUpperCase()}/${targetCurrency.toUpperCase()}`;

    const snapshotHash = this.generateSnapshotHash(
      sourceCurrency.toUpperCase(),
      targetCurrency.toUpperCase(),
      combinedRate,
      effectiveTimestamp,
      combinedSource,
    );

    return {
      sourceCurrency: sourceCurrency.toUpperCase(),
      targetCurrency: targetCurrency.toUpperCase(),
      rate: combinedRate,
      rateTimestamp: effectiveTimestamp,
      rateSource: combinedSource,
      pair,
      snapshotHash,
      version: '1.0',
    };
  }

  /**
   * Applies an existing immutable historical snapshot to an amount.
   * Strictly enforces that historical trades NEVER recalculate using current rates.
   */
  public convertWithHistoricalSnapshot(amount: number, snapshot: FxRateSnapshot): number {
    if (!snapshot || typeof snapshot.rate !== 'number' || !Number.isFinite(snapshot.rate) || snapshot.rate <= 0) {
      throw new BadRequestException('[INVALID_HISTORICAL_SNAPSHOT] Historical FX snapshot rate is missing or invalid');
    }

    // Verify snapshot integrity
    if (!this.verifySnapshot(snapshot)) {
      this.logger.warn(`[FX_SNAPSHOT_HASH_MISMATCH] Snapshot for ${snapshot.pair} hash mismatch`);
    }

    return Number((amount * snapshot.rate).toFixed(4));
  }

  /**
   * Verifies the cryptographic integrity of an FX snapshot.
   */
  public verifySnapshot(snapshot: FxRateSnapshot): boolean {
    if (!snapshot || !snapshot.snapshotHash) return false;
    const computedHash = this.generateSnapshotHash(
      snapshot.sourceCurrency,
      snapshot.targetCurrency,
      snapshot.rate,
      snapshot.rateTimestamp,
      snapshot.rateSource,
    );
    return computedHash === snapshot.snapshotHash;
  }

  /**
   * Manually registers a point-in-time rate record (e.g. from external oracle / live broker feed).
   */
  public registerRate(record: IFxRateRecord): void {
    this.converter.registerRate(record);
  }
}
