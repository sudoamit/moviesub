import { Direction, SignalGrade, SignalState, Timeframe } from '../enums';

export interface ITradeJournalRecord {
  readonly id: string;
  readonly tradeId: string;
  readonly positionId?: string;
  readonly orderId?: string;
  readonly symbol: string;
  readonly contractSymbol?: string;
  readonly instrumentType?: 'SPOT' | 'OPTION' | 'FUTURES';
  readonly strike?: number;
  readonly optionType?: 'CE' | 'PE';
  readonly direction: 'BULLISH' | 'BEARISH' | 'BUY' | 'SELL';
  readonly side: 'BUY' | 'SELL';

  // Sizing
  readonly quantity: number;

  // Execution Facts (Aggregated strictly from actual fills)
  readonly requestedEntryPrice?: number | null;
  readonly actualEntryPrice: number | null;
  readonly actualEntryPriceCurrency: string | null;

  readonly actualExitPrice: number | null;
  readonly actualExitPriceCurrency: string | null;

  readonly entryTimeUtc: string | null;
  readonly exitTimeUtc: string | null;

  readonly holdingDurationMs: number | null;
  readonly holdingDurationSeconds: number | null;

  // Multi-Asset P&L & Accounting (Nullable for legacy/incomplete execution data)
  readonly quotePnl?: number | null;
  readonly quoteCurrency?: string | null;

  readonly netPnlAccount?: number | null;
  readonly accountCurrency: string;
  readonly chargesAccount: number;
  readonly realizedR?: number | null;
  readonly leverage?: number;

  // Metadata & Confluence
  readonly state: SignalState | string;
  readonly grade?: SignalGrade | string;
  readonly score?: number;
  readonly timeframe?: Timeframe | string;
  readonly tradeReason?: string;
  readonly checklist?: string[];
  readonly exitReason: string;

  // Provenance & Aggregation Details
  readonly executionSource: string;
  readonly entryFillCount: number;
  readonly exitFillCount: number;
  readonly accountingSnapshotHash?: string;
  readonly isLegacyExecutionData?: boolean;
  readonly executionDataComplete?: boolean;

  /**
   * @deprecated
   * [DEPRECATED | NON-AUTHORITATIVE | DO NOT USE FOR EXECUTION ACCOUNTING]
   * Legacy compatibility field. Use `actualEntryPrice` for authoritative execution price.
   */
  readonly entryPrice?: number | null;
  /**
   * @deprecated
   * [DEPRECATED | NON-AUTHORITATIVE | DO NOT USE FOR EXECUTION ACCOUNTING]
   * Legacy compatibility field. Use `actualEntryPriceCurrency` or `quoteCurrency`.
   */
  readonly entryPriceCurrency?: string | null;
  /**
   * @deprecated
   * [DEPRECATED | NON-AUTHORITATIVE | DO NOT USE FOR EXECUTION ACCOUNTING]
   * Legacy compatibility field. Use `actualExitPrice`.
   */
  readonly exitPrice?: number | null;
  /**
   * @deprecated
   * [DEPRECATED | NON-AUTHORITATIVE | DO NOT USE FOR EXECUTION ACCOUNTING]
   * Legacy compatibility field. Use `actualExitPriceCurrency`.
   */
  readonly exitPriceCurrency?: string | null;
  readonly durationMs?: number | null;
  readonly durationMinutes?: number | null;
  readonly totalChargesAccount?: number;
}

export interface IJournalStatsSummary {
  readonly totalTrades: number;
  readonly totalVerifiedTrades?: number;
  readonly legacyTradeCount?: number;
  readonly executionDataFilter?: 'VERIFIED' | 'LEGACY' | 'ALL';
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly winRate: number;
  readonly totalPnlAccount: number;
  readonly accountCurrency: string;
  readonly profitFactor: number;
  readonly averageR: number;
}

export interface IJournalResponse {
  readonly stats: IJournalStatsSummary;
  readonly trades: ITradeJournalRecord[];
}
