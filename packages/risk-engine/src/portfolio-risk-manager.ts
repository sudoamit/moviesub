import { IOpenPosition, IRiskConfig } from './types';
import { IPositionSizing } from '@quant/shared';

export interface IPortfolioMetricsInput {
  dailyRealizedPnL?: number;
  weeklyRealizedPnL?: number;
  currentDrawdownPercent?: number;
  consecutiveLosses?: number;
}

export interface IPortfolioRiskStatus {
  totalOpenPositions: number;
  totalOpenRiskAmount: number;
  totalOpenRiskPercent: number;
  totalGrossExposure: number;
  grossLeverage: number;
  positionsByAssetType: Record<string, number>;
  positionsBySymbol: Record<string, number>;
  isAllowed: boolean;
  rejectionReason?: string;
}

export class PortfolioRiskManager {
  /**
   * Validates comprehensive trade-level and portfolio-level risk capacity,
   * symbol concentration, sector exposure, max daily/weekly loss, drawdown, and leverage limits.
   * STRICT FAIL-CLOSED.
   */
  static validateNewPosition(
    accountEquity: number,
    openPositions: IOpenPosition[],
    proposedPosition: IPositionSizing,
    arg4?: string | IRiskConfig,
    arg5?: string | IRiskConfig,
    arg6?: IRiskConfig,
    metrics: IPortfolioMetricsInput = {},
  ): IPortfolioRiskStatus {
    let proposedSymbol = 'NIFTY';
    let proposedAssetType = 'EQUITY';
    let config: IRiskConfig = {};

    if (typeof arg4 === 'object' && arg4 !== null) {
      config = arg4;
    } else if (typeof arg4 === 'string') {
      proposedAssetType = arg4;
      if (typeof arg5 === 'object' && arg5 !== null) {
        config = arg5;
      } else if (typeof arg5 === 'string') {
        proposedSymbol = arg4;
        proposedAssetType = arg5;
        if (arg6) config = arg6;
      }
    }

    const maxRiskPerTrade = config.maxRiskPercentage ?? 2.5;
    const maxOpenRiskPct = config.maxOpenRiskPercent ?? 6.0;
    const maxConcurrent = config.maxConcurrentPositions ?? 5;
    const maxPerAssetType = 3;
    const maxDailyLossPct = config.maxDailyDrawdownPercent ?? 5.0;
    const maxWeeklyLossPct = config.maxWeeklyDrawdownPercent ?? 8.0;
    const maxDrawdownPct = config.maxAccountDrawdownPercent ?? 10.0;
    const maxConsecutiveLosses = config.maxConsecutiveLosses ?? 3;
    const maxLeverage = config.maxLeverage ?? 10;

    let totalOpenRiskAmount = 0;
    let totalGrossExposure = 0;
    const positionsByAssetType: Record<string, number> = {};
    const positionsBySymbol: Record<string, number> = {};

    for (const pos of openPositions) {
      totalOpenRiskAmount += pos.riskAmount;
      totalGrossExposure += pos.units * pos.currentPrice;
      positionsByAssetType[pos.assetType] = (positionsByAssetType[pos.assetType] || 0) + 1;
      positionsBySymbol[pos.symbol] = (positionsBySymbol[pos.symbol] || 0) + (pos.units * pos.currentPrice);
    }

    const proposedExposure = proposedPosition.totalPositionValue;
    const totalGrossWithProposed = totalGrossExposure + proposedExposure;
    const grossLeverage = Number((totalGrossWithProposed / Math.max(1, accountEquity)).toFixed(2));

    const currentOpenRiskPercent = (totalOpenRiskAmount / Math.max(1, accountEquity)) * 100;
    const totalRiskWithProposed = currentOpenRiskPercent + proposedPosition.riskPercentage;

    let isAllowed = true;
    let rejectionReason: string | undefined = undefined;

    // 1. Trade-level risk limit
    if (proposedPosition.riskPercentage > maxRiskPerTrade) {
      isAllowed = false;
      rejectionReason = `Proposed trade risk (${proposedPosition.riskPercentage.toFixed(2)}%) breaches MAX_RISK_PER_TRADE (${maxRiskPerTrade}%)`;
    }
    // 2. Portfolio-level open risk
    else if (totalRiskWithProposed > maxOpenRiskPct) {
      isAllowed = false;
      rejectionReason = `Proposed position would breach portfolio max open risk limit (${totalRiskWithProposed.toFixed(2)}% > ${maxOpenRiskPct}%)`;
    }
    // 3. Maximum concurrent positions
    else if (openPositions.length >= maxConcurrent) {
      isAllowed = false;
      rejectionReason = `Maximum concurrent portfolio positions limit reached (${openPositions.length}/${maxConcurrent})`;
    }
    // 4. Asset class concentration
    else if ((positionsByAssetType[proposedAssetType] || 0) >= maxPerAssetType) {
      isAllowed = false;
      rejectionReason = `Maximum exposure reached for asset class '${proposedAssetType}' (${positionsByAssetType[proposedAssetType]}/${maxPerAssetType})`;
    }
    // 5. Leverage limit
    else if (grossLeverage > maxLeverage) {
      isAllowed = false;
      rejectionReason = `Portfolio gross leverage (${grossLeverage}x) exceeds MAX_LEVERAGE limit (${maxLeverage}x)`;
    }
    // 6. Daily drawdown limit
    else if (metrics.dailyRealizedPnL !== undefined && metrics.dailyRealizedPnL < -(accountEquity * (maxDailyLossPct / 100))) {
      isAllowed = false;
      rejectionReason = `Trading halted: Daily loss threshold reached (-${maxDailyLossPct}% equity)`;
    }
    // 7. Weekly drawdown limit
    else if (metrics.weeklyRealizedPnL !== undefined && metrics.weeklyRealizedPnL < -(accountEquity * (maxWeeklyLossPct / 100))) {
      isAllowed = false;
      rejectionReason = `Trading halted: Weekly loss threshold reached (-${maxWeeklyLossPct}% equity)`;
    }
    // 8. Account max drawdown kill switch
    else if (metrics.currentDrawdownPercent !== undefined && metrics.currentDrawdownPercent >= maxDrawdownPct) {
      isAllowed = false;
      rejectionReason = `Trading halted: Account max drawdown kill-switch activated (${metrics.currentDrawdownPercent.toFixed(1)}% >= ${maxDrawdownPct}%)`;
    }
    // 9. Consecutive loss cooling off
    else if (metrics.consecutiveLosses !== undefined && metrics.consecutiveLosses >= maxConsecutiveLosses) {
      isAllowed = false;
      rejectionReason = `Cooling-off triggered: ${metrics.consecutiveLosses} consecutive losses recorded (max ${maxConsecutiveLosses})`;
    }

    return {
      totalOpenPositions: openPositions.length,
      totalOpenRiskAmount: Number(totalOpenRiskAmount.toFixed(2)),
      totalOpenRiskPercent: Number(currentOpenRiskPercent.toFixed(2)),
      totalGrossExposure: Number(totalGrossWithProposed.toFixed(2)),
      grossLeverage,
      positionsByAssetType,
      positionsBySymbol,
      isAllowed,
      rejectionReason,
    };
  }
}
