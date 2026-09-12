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

  // Execution Facts (Aggregated from actual fills)
  readonly quantity: number;
  readonly entryPrice: number;
  readonly entryPriceCurrency: string;
  readonly entryTimeUtc: string;

  readonly exitPrice: number;
  readonly exitPriceCurrency: string;
  readonly exitTimeUtc: string;

  readonly durationMs: number;
  readonly durationMinutes: number;

  // Multi-Asset P&L & Accounting
  readonly netPnlAccount: number;
  readonly accountCurrency: string;
  readonly quotePnl?: number;
  readonly quoteCurrency?: string;
  readonly totalChargesAccount: number;
  readonly realizedR?: number;
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
}

export interface IJournalStatsSummary {
  readonly totalTrades: number;
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
