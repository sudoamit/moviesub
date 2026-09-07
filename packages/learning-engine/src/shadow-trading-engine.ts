import { Direction } from '@quant/shared';
import { ShadowTradeRecord, StrategyCandidate } from './types';

export class ShadowTradingEngine {
  private static activeShadowCandidates: Map<string, StrategyCandidate> = new Map();
  private static shadowTrades: ShadowTradeRecord[] = [];

  /**
   * Activates a validated candidate in shadow trading mode.
   */
  public static activateCandidate(candidate: StrategyCandidate): void {
    candidate.status = 'SHADOW';
    this.activeShadowCandidates.set(candidate.id, candidate);
  }

  /**
   * Deactivates a candidate from shadow trading.
   */
  public static deactivateCandidate(candidateId: string): void {
    this.activeShadowCandidates.delete(candidateId);
  }

  /**
   * Processes a live tick / candle to record shadow executions for active shadow candidates.
   */
  public static recordShadowSignal(
    candidateId: string,
    symbol: string,
    direction: Direction,
    entryPrice: number,
    timeframe = '15m',
  ): ShadowTradeRecord {
    const trade: ShadowTradeRecord = {
      id: `shadow-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      candidateId,
      symbol,
      timeframe,
      direction,
      entryPrice,
      entryTime: new Date(),
      isClosed: false,
    };
    this.shadowTrades.push(trade);
    return trade;
  }

  /**
   * Closes a shadow trade upon exit trigger.
   */
  public static closeShadowTrade(
    shadowTradeId: string,
    exitPrice: number,
    stopLossPrice: number,
  ): ShadowTradeRecord | undefined {
    const trade = this.shadowTrades.find((t) => t.id === shadowTradeId);
    if (!trade || trade.isClosed) return trade;

    const isLong = trade.direction === Direction.BULLISH;
    const diff = isLong ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
    const riskPerUnit = Math.abs(trade.entryPrice - stopLossPrice);

    trade.exitPrice = exitPrice;
    trade.exitTime = new Date();
    trade.pnl = Number(diff.toFixed(2));
    trade.pnlR = riskPerUnit > 0 ? Number((diff / riskPerUnit).toFixed(2)) : 0;
    trade.isClosed = true;

    return trade;
  }

  /**
   * Evaluates aggregate shadow performance for a candidate.
   */
  public static getShadowPerformance(candidateId: string): {
    tradeCount: number;
    expectancyR: number;
    winRate: number;
    maxDrawdownR: number;
    trades: ShadowTradeRecord[];
  } {
    const trades = this.shadowTrades.filter((t) => t.candidateId === candidateId && t.isClosed);
    const tradeCount = trades.length;

    if (tradeCount === 0) {
      return { tradeCount: 0, expectancyR: 0, winRate: 0, maxDrawdownR: 0, trades: [] };
    }

    const rList = trades.map((t) => t.pnlR || 0);
    const sumR = rList.reduce((a, b) => a + b, 0);
    const expectancyR = Number((sumR / tradeCount).toFixed(2));

    const wins = rList.filter((r) => r > 0).length;
    const winRate = Number(((wins / tradeCount) * 100).toFixed(1));

    let peakR = 0;
    let runningR = 0;
    let maxDD = 0;
    for (const r of rList) {
      runningR += r;
      if (runningR > peakR) peakR = runningR;
      const dd = peakR - runningR;
      if (dd > maxDD) maxDD = dd;
    }

    return {
      tradeCount,
      expectancyR,
      winRate,
      maxDrawdownR: Number(maxDD.toFixed(2)),
      trades,
    };
  }

  /**
   * Retrieves all active shadow candidates.
   */
  public static getActiveCandidates(): StrategyCandidate[] {
    return Array.from(this.activeShadowCandidates.values());
  }
}
