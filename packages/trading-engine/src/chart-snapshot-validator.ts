import { ChartMarketSnapshot, ChartSMCSnapshot } from '@quant/shared';

export interface ISnapshotValidationResult {
  readonly isValid: boolean;
  readonly errors: string[];
  readonly error?: string;
}

export class ChartSnapshotValidator {
  static validateClosedCandles(closedCandles: any[]): ISnapshotValidationResult {
    const errors: string[] = [];

    if (!Array.isArray(closedCandles)) {
      return { isValid: false, errors: ['closedCandles must be an array'], error: 'closedCandles must be an array' };
    }

    if (closedCandles.length === 0) {
      return { isValid: false, errors: ['closedCandles array is empty.'], error: 'closedCandles array is empty.' };
    }

    let prevTime = -1;
    const seenTimes = new Set<string>();

    for (let i = 0; i < closedCandles.length; i++) {
      const c = closedCandles[i];

      if (c.provenance === 'SYNTHETIC_FALLBACK') {
        errors.push(`Candle ${i} has invalid provenance: SYNTHETIC_FALLBACK. Synthetic data is prohibited.`);
      }

      if (c.isClosed !== true) {
        errors.push(`Candle ${i} in closedCandles array has isClosed = false. closedCandles must only contain closed candles.`);
      }

      const tsStr = typeof c.timestamp === 'string' ? c.timestamp : c.timestamp?.toISOString?.() || String(c.timestamp);
      if (seenTimes.has(tsStr)) {
        errors.push(`Duplicate timestamp detected at index ${i}: ${tsStr}`);
      }
      seenTimes.add(tsStr);

      const timeSec = Math.floor(new Date(c.timestamp).getTime() / 1000);
      if (isNaN(timeSec)) {
        errors.push(`Invalid timestamp at index ${i}`);
      } else if (timeSec <= prevTime) {
        errors.push(`Non-chronological timestamp at index ${i}: prev=${prevTime}, current=${timeSec}`);
      } else {
        prevTime = timeSec;
      }

      // OHLC Invariants
      if (c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) {
        errors.push(`Candle ${i} has invalid OHLC relationship: open=${c.open}, high=${c.high}, low=${c.low}, close=${c.close}`);
      }
      if (c.volume < 0) {
        errors.push(`Volume < 0 at index ${i}: volume=${c.volume}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      error: errors[0],
    };
  }

  static validateSnapshot(
    snapshot: ChartMarketSnapshot | null | undefined,
    targetSymbol?: string,
    targetTimeframe?: string,
  ): ISnapshotValidationResult {
    if (!snapshot) {
      return { isValid: false, errors: ['Snapshot is null or undefined'], error: 'Snapshot is null or undefined' };
    }

    const errors: string[] = [];

    if (!snapshot.symbol || !snapshot.timeframe) {
      errors.push('Snapshot missing symbol or timeframe');
    }

    if (targetSymbol && snapshot.symbol.toUpperCase() !== targetSymbol.toUpperCase()) {
      errors.push(`Snapshot symbol ${snapshot.symbol} does not match target symbol ${targetSymbol}.`);
    }

    if (targetTimeframe && snapshot.timeframe.toLowerCase() !== targetTimeframe.toLowerCase()) {
      errors.push(`Snapshot timeframe ${snapshot.timeframe} does not match target timeframe ${targetTimeframe}.`);
    }

    if (snapshot.livePrice !== null && snapshot.livePrice !== undefined) {
      if (typeof snapshot.livePrice !== 'number' || isNaN(snapshot.livePrice) || snapshot.livePrice < 0) {
        errors.push(`Snapshot livePrice is invalid: ${snapshot.livePrice}`);
      }
    }

    const closedRes = this.validateClosedCandles(snapshot.closedCandles || []);
    if (!closedRes.isValid) {
      errors.push(...closedRes.errors);
    }

    const { closedCandles, formingCandle, smcSnapshot } = snapshot;

    // Validate forming candle if present
    if (formingCandle) {
      const fTimeSec = Math.floor(new Date(formingCandle.timestamp).getTime() / 1000);
      if (isNaN(fTimeSec)) {
        errors.push('Invalid forming candle timestamp');
      }

      if (closedCandles && closedCandles.length > 0) {
        const lastClosedTimeSec = Math.floor(
          new Date(closedCandles[closedCandles.length - 1].timestamp).getTime() / 1000,
        );
        if (fTimeSec < lastClosedTimeSec) {
          errors.push(
            `Forming candle timestamp ${formingCandle.timestamp} is strictly before the latest closed candle timestamp ${closedCandles[closedCandles.length - 1].timestamp}.`,
          );
        }
      }

      if (formingCandle.high < Math.max(formingCandle.open, formingCandle.close)) {
        errors.push('Forming candle OHLC violation: high < max(open, close)');
      }
      if (formingCandle.low > Math.min(formingCandle.open, formingCandle.close)) {
        errors.push('Forming candle OHLC violation: low > min(open, close)');
      }
      if (formingCandle.volume < 0) {
        errors.push('Forming candle volume < 0');
      }
    }

    // Single live price authority check when formingCandle exists
    if (formingCandle && snapshot.livePrice !== null && snapshot.livePrice !== undefined) {
      if (snapshot.livePrice !== formingCandle.close) {
        errors.push(
          `Snapshot livePrice (${snapshot.livePrice}) does not match formingCandle close (${formingCandle.close}).`,
        );
      }
    }

    // Validate SMC snapshot identity match if present
    if (smcSnapshot) {
      if (!this.validateSMCSnapshot(smcSnapshot, snapshot.symbol, snapshot.timeframe)) {
        errors.push(
          `SMC snapshot identity mismatch: expected ${snapshot.symbol}/${snapshot.timeframe}, got ${smcSnapshot.symbol}/${smcSnapshot.timeframe}`,
        );
      }

      if (smcSnapshot.structureAsOf && smcSnapshot.computedAt) {
        const structMs = new Date(smcSnapshot.structureAsOf).getTime();
        const compMs = new Date(smcSnapshot.computedAt).getTime();
        if (!isNaN(structMs) && !isNaN(compMs) && structMs > compMs) {
          errors.push(
            `smcSnapshot structureAsOf (${smcSnapshot.structureAsOf}) is strictly after computedAt (${smcSnapshot.computedAt}).`,
          );
        }
      }

      if (smcSnapshot.structureAsOf && snapshot.closedThrough) {
        const structMs = new Date(smcSnapshot.structureAsOf).getTime();
        const closedThroughMs = new Date(snapshot.closedThrough).getTime();
        if (!isNaN(structMs) && !isNaN(closedThroughMs) && structMs !== closedThroughMs) {
          errors.push(
            `smcSnapshot structureAsOf (${smcSnapshot.structureAsOf}) does not match snapshot closedThrough (${snapshot.closedThrough}).`,
          );
        }
      }
    }

    if (snapshot.closedThrough && closedCandles && closedCandles.length > 0) {
      const closedThroughMs = new Date(snapshot.closedThrough).getTime();
      const lastClosedMs = new Date(closedCandles[closedCandles.length - 1].timestamp).getTime();
      if (!isNaN(closedThroughMs) && !isNaN(lastClosedMs) && closedThroughMs !== lastClosedMs) {
        errors.push(
          `snapshot closedThrough (${snapshot.closedThrough}) does not match latest closed candle timestamp (${closedCandles[closedCandles.length - 1].timestamp}).`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      error: errors[0],
    };
  }

  static validateSMCSnapshot(
    smc: ChartSMCSnapshot | null | undefined,
    targetSymbol: string,
    targetTimeframe: string,
  ): boolean {
    if (!smc) return false;
    if (
      smc.symbol.toUpperCase() !== targetSymbol.toUpperCase() ||
      smc.timeframe.toLowerCase() !== targetTimeframe.toLowerCase()
    ) {
      return false;
    }

    if (smc.orderBlocks) {
      for (const ob of smc.orderBlocks) {
        if (!ob.timestamp) return false;
      }
    }
    if (smc.fvgs) {
      for (const fvg of smc.fvgs) {
        if (!fvg.timestamp) return false;
      }
    }

    return true;
  }
}

