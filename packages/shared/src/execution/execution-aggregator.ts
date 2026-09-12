/**
 * Canonical Execution Aggregator for Trading Fills & Trade Lifecycles.
 *
 * NON-NEGOTIABLE EXECUTION RULES:
 * 1. Entry Price: Weighted Average Price (VWAP) of actual entry fills: Σ(fillPrice * fillQuantity) / Σ(fillQuantity)
 * 2. Entry Time: Earliest actual entry fill timestamp (UTC).
 * 3. Exit Price: Weighted Average Price (VWAP) of actual exit fills: Σ(fillPrice * fillQuantity) / Σ(fillQuantity)
 * 4. Exit Time: Latest actual exit fill timestamp (UTC).
 * 5. Duration: exitTime - entryTime in UTC milliseconds.
 * 6. Fill Ownership & Deduplication: Each fill must have a unique fillId. Fills must not be double counted.
 * 7. Strict Fail-Closed: Never manufacture fills, prices, or timestamps.
 */

export interface IFillRecord {
  readonly fillId: string;
  readonly orderId?: string;
  readonly positionId?: string;
  readonly tradeId?: string;
  readonly executionRole: 'ENTRY' | 'EXIT';
  readonly fillPrice: number;
  readonly fillQuantity: number;
  readonly fillTimestamp: number | Date | string;
  readonly fee?: number;
  readonly slippage?: number;
  readonly sourceTimestamp?: number | Date | string;
  readonly liquidityType?: 'MAKER' | 'TAKER' | string;
  readonly executionPriceSource?: string;
}

export interface IAggregatedLeg {
  readonly weightedPrice: number;
  readonly totalQuantity: number;
  readonly totalFees: number;
  readonly totalTurnover: number;
  readonly fillCount: number;
  readonly earliestFillTimestamp: number;
  readonly latestFillTimestamp: number;
  readonly earliestFillTimeUtc: string;
  readonly latestFillTimeUtc: string;
  readonly fillIds: string[];
}

export interface IAggregatedExecution {
  readonly entry: IAggregatedLeg;
  readonly exit: IAggregatedLeg;
  readonly durationMs: number;
  readonly durationMinutes: number;
  readonly totalFees: number;
  readonly isFullyClosed: boolean;
}

export class ExecutionAggregator {
  /**
   * Normalizes any valid timestamp input into canonical epoch milliseconds.
   */
  public static parseTimestamp(ts: number | Date | string): number {
    if (typeof ts === 'number') {
      if (!Number.isFinite(ts) || ts <= 0) {
        throw new Error(`[ExecutionAggregator] Invalid numeric timestamp: ${ts}`);
      }
      return ts;
    }
    if (ts instanceof Date) {
      const ms = ts.getTime();
      if (Number.isNaN(ms)) {
        throw new Error('[ExecutionAggregator] Invalid Date object provided');
      }
      return ms;
    }
    if (typeof ts === 'string') {
      const parsed = Date.parse(ts);
      if (Number.isNaN(parsed)) {
        throw new Error(`[ExecutionAggregator] Failed to parse ISO timestamp string: '${ts}'`);
      }
      return parsed;
    }
    throw new Error(`[ExecutionAggregator] Unsupported timestamp type: ${typeof ts}`);
  }

  /**
   * Validates and aggregates a collection of fills for a single trade leg (ENTRY or EXIT).
   */
  public static aggregateLeg(
    fills: IFillRecord[],
    expectedRole: 'ENTRY' | 'EXIT',
  ): IAggregatedLeg {
    if (!fills || fills.length === 0) {
      throw new Error(`[ExecutionAggregator] Cannot aggregate empty ${expectedRole} fills array`);
    }

    const seenIds = new Set<string>();
    let totalTurnover = 0;
    let totalQuantity = 0;
    let totalFees = 0;
    let earliestFillTimestamp = Infinity;
    let latestFillTimestamp = -Infinity;
    const fillIds: string[] = [];

    for (const fill of fills) {
      if (!fill.fillId) {
        throw new Error(`[ExecutionAggregator] Fill missing unique fillId in ${expectedRole} leg`);
      }
      if (seenIds.has(fill.fillId)) {
        throw new Error(
          `[ExecutionAggregator] Duplicate fill detected with fillId '${fill.fillId}' in ${expectedRole} leg`,
        );
      }
      seenIds.add(fill.fillId);
      fillIds.push(fill.fillId);

      if (fill.executionRole !== expectedRole) {
        throw new Error(
          `[ExecutionAggregator] Role mismatch: expected '${expectedRole}', found '${fill.executionRole}' on fill '${fill.fillId}'`,
        );
      }

      if (!Number.isFinite(fill.fillPrice) || fill.fillPrice <= 0) {
        throw new Error(
          `[ExecutionAggregator] Invalid fillPrice '${fill.fillPrice}' on fill '${fill.fillId}'`,
        );
      }
      if (!Number.isFinite(fill.fillQuantity) || fill.fillQuantity <= 0) {
        throw new Error(
          `[ExecutionAggregator] Invalid fillQuantity '${fill.fillQuantity}' on fill '${fill.fillId}'`,
        );
      }

      const tsMs = this.parseTimestamp(fill.fillTimestamp);
      if (tsMs < earliestFillTimestamp) earliestFillTimestamp = tsMs;
      if (tsMs > latestFillTimestamp) latestFillTimestamp = tsMs;

      const fillTurnover = fill.fillPrice * fill.fillQuantity;
      totalTurnover += fillTurnover;
      totalQuantity += fill.fillQuantity;
      totalFees += fill.fee ?? 0;
    }

    if (totalQuantity <= 0) {
      throw new Error(
        `[ExecutionAggregator] Total aggregated quantity must be positive, received ${totalQuantity}`,
      );
    }

    const weightedPrice = totalTurnover / totalQuantity;

    return {
      weightedPrice,
      totalQuantity,
      totalFees,
      totalTurnover,
      fillCount: fills.length,
      earliestFillTimestamp,
      latestFillTimestamp,
      earliestFillTimeUtc: new Date(earliestFillTimestamp).toISOString(),
      latestFillTimeUtc: new Date(latestFillTimestamp).toISOString(),
      fillIds,
    };
  }

  /**
   * Aggregates entry fills and exit fills into a complete trade lifecycle execution.
   */
  public static aggregateTradeLifecycle(
    entryFills: IFillRecord[],
    exitFills: IFillRecord[],
  ): IAggregatedExecution {
    const entry = this.aggregateLeg(entryFills, 'ENTRY');
    const exit = this.aggregateLeg(exitFills, 'EXIT');

    // Cross-check duplicate fill IDs across legs
    const entrySet = new Set(entry.fillIds);
    for (const exitFillId of exit.fillIds) {
      if (entrySet.has(exitFillId)) {
        throw new Error(
          `[ExecutionAggregator] Fill '${exitFillId}' was submitted as both ENTRY and EXIT fill`,
        );
      }
    }

    const durationMs = Math.max(0, exit.latestFillTimestamp - entry.earliestFillTimestamp);
    const durationMinutes = Number((durationMs / 60000).toFixed(2));
    const totalFees = Number((entry.totalFees + exit.totalFees).toFixed(4));
    const isFullyClosed = Math.abs(entry.totalQuantity - exit.totalQuantity) < 1e-6;

    return {
      entry,
      exit,
      durationMs,
      durationMinutes,
      totalFees,
      isFullyClosed,
    };
  }
}
