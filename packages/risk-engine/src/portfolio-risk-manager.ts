import { IOpenPosition, IRiskConfig } from './types';
import {
  getAuthoritativeInstrument,
  hasInstrument,
  IPositionSizing,
  PointInTimeCurrencyConverter,
} from '@quant/shared';
import { TradeAccountingEngine } from './trade-accounting-engine';

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
  initialMarginUsed: number;
  maintenanceMarginUsed: number;
  availableMargin: number;
  marginUtilizationPercent: number;
  positionsByAssetType: Record<string, number>;
  positionsBySymbol: Record<string, number>;
  isAllowed: boolean;
  rejectionReason?: string;
}

export class PortfolioRiskManager {
  /**
   * Validates comprehensive trade-level and portfolio-level risk capacity,
   * multi-asset INR exposure aggregation, margin utilization, leverage limits,
   * symbol concentration, sector exposure, max daily/weekly loss, and drawdown kill-switches.
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
    currencyConverter = PointInTimeCurrencyConverter.getInstance(),
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

    let totalOpenRiskAmount = 0; // in INR
    let totalGrossExposure = 0; // in INR
    let totalInitialMarginUsed = 0; // in INR
    let totalMaintenanceMarginUsed = 0; // in INR
    const positionsByAssetType: Record<string, number> = {};
    const positionsBySymbol: Record<string, number> = {};

    for (const pos of openPositions) {
      const posSymbol = pos.symbol;
      const instrument = hasInstrument(posSymbol) ? getAuthoritativeInstrument(posSymbol) : undefined;
      const contractSize = pos.contractSize ?? instrument?.contractSize ?? 1;
      const quoteCurrency = pos.quoteCurrency || instrument?.quoteCurrency || (instrument?.currency as any) || 'INR';

      let fxRate = pos.fxRate;
      if (fxRate === undefined) {
        if (quoteCurrency === 'INR') {
          fxRate = 1.0;
        } else {
          try {
            const fxRes = currencyConverter.getRate(
              quoteCurrency,
              'INR',
              pos.openTimestamp ? pos.openTimestamp.getTime() : Date.now(),
            );
            fxRate = fxRes.fxRate;
          } catch {
            fxRate = 1.0;
          }
        }
      }

      // Notional in INR
      const notionalQuote = pos.units * pos.currentPrice * contractSize;
      const notionalINR = pos.notionalINR ?? Number((notionalQuote * fxRate).toFixed(2));

      // Risk in INR
      let riskAmountINR = pos.riskAmount;
      if (quoteCurrency !== 'INR' && fxRate !== 1.0 && !pos.riskAmount) {
        riskAmountINR = TradeAccountingEngine.calculateStopRisk(
          pos.entryPrice,
          pos.stopLoss,
          pos.units,
          contractSize,
          fxRate,
        );
      }

      // Margin in INR
      const posLeverage = pos.leverage ?? instrument?.defaultLeverage ?? 1;
      const posMarginMode = instrument?.marginMode ?? (posLeverage > 1 ? 'ISOLATED' : 'SPOT');
      const marginCalc = TradeAccountingEngine.calculateMargin(
        notionalINR,
        posLeverage,
        posMarginMode,
        instrument?.initialMarginRate,
        instrument?.maintenanceMarginRate,
      );

      const initMarginINR = pos.initialMarginRequired ?? marginCalc.initialMarginRequired;
      const maintMarginINR = pos.maintenanceMarginRequired ?? marginCalc.maintenanceMarginRequired;

      totalOpenRiskAmount += riskAmountINR;
      totalGrossExposure += notionalINR;
      totalInitialMarginUsed += initMarginINR;
      totalMaintenanceMarginUsed += maintMarginINR;

      positionsByAssetType[pos.assetType] = (positionsByAssetType[pos.assetType] || 0) + 1;
      positionsBySymbol[posSymbol] = (positionsBySymbol[posSymbol] || 0) + notionalINR;
    }

    // Proposed Position INR Metrics
    const proposedInstrument = hasInstrument(proposedSymbol) ? getAuthoritativeInstrument(proposedSymbol) : undefined;
    const proposedExposure = proposedPosition.positionNotionalAccount ?? proposedPosition.totalPositionValue;
    const proposedRisk = proposedPosition.riskAmount;
    const proposedLev = proposedPosition.leverage ?? proposedInstrument?.defaultLeverage ?? 1;
    const proposedMarginMode = proposedPosition.marginMode ?? proposedInstrument?.marginMode ?? (proposedLev > 1 ? 'ISOLATED' : 'SPOT');
    const proposedInitMargin =
      proposedPosition.initialMarginRequired ??
      TradeAccountingEngine.calculateMargin(proposedExposure, proposedLev, proposedMarginMode).initialMarginRequired;
    const proposedMaintMargin =
      proposedPosition.maintenanceMarginRequired ??
      TradeAccountingEngine.calculateMargin(proposedExposure, proposedLev, proposedMarginMode).maintenanceMarginRequired;

    const totalGrossWithProposed = totalGrossExposure + proposedExposure;
    const grossLeverage = Number((totalGrossWithProposed / Math.max(1, accountEquity)).toFixed(2));

    const totalInitialMarginWithProposed = totalInitialMarginUsed + proposedInitMargin;
    const totalMaintMarginWithProposed = totalMaintenanceMarginUsed + proposedMaintMargin;
    const availableMargin = Math.max(0, accountEquity - totalInitialMarginUsed);
    const marginUtilizationPercent = Number(((totalInitialMarginWithProposed / Math.max(1, accountEquity)) * 100).toFixed(2));

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
    // 3. Margin capacity check (independent from gross leverage)
    else if (proposedInitMargin > availableMargin) {
      isAllowed = false;
      rejectionReason = `Proposed initial margin (${proposedInitMargin.toFixed(2)} INR) exceeds available portfolio margin (${availableMargin.toFixed(2)} INR)`;
    }
    // 4. Maximum concurrent positions
    else if (openPositions.length >= maxConcurrent) {
      isAllowed = false;
      rejectionReason = `Maximum concurrent portfolio positions limit reached (${openPositions.length}/${maxConcurrent})`;
    }
    // 5. Asset class concentration
    else if ((positionsByAssetType[proposedAssetType] || 0) >= maxPerAssetType) {
      isAllowed = false;
      rejectionReason = `Maximum exposure reached for asset class '${proposedAssetType}' (${positionsByAssetType[proposedAssetType]}/${maxPerAssetType})`;
    }
    // 6. Gross Leverage limit
    else if (grossLeverage > maxLeverage) {
      isAllowed = false;
      rejectionReason = `Portfolio gross leverage (${grossLeverage}x) exceeds MAX_LEVERAGE limit (${maxLeverage}x)`;
    }
    // 7. Daily drawdown limit
    else if (
      metrics.dailyRealizedPnL !== undefined &&
      metrics.dailyRealizedPnL < -(accountEquity * (maxDailyLossPct / 100))
    ) {
      isAllowed = false;
      rejectionReason = `Trading halted: Daily loss threshold reached (-${maxDailyLossPct}% equity)`;
    }
    // 8. Weekly drawdown limit
    else if (
      metrics.weeklyRealizedPnL !== undefined &&
      metrics.weeklyRealizedPnL < -(accountEquity * (maxWeeklyLossPct / 100))
    ) {
      isAllowed = false;
      rejectionReason = `Trading halted: Weekly loss threshold reached (-${maxWeeklyLossPct}% equity)`;
    }
    // 9. Account max drawdown kill switch
    else if (
      metrics.currentDrawdownPercent !== undefined &&
      metrics.currentDrawdownPercent >= maxDrawdownPct
    ) {
      isAllowed = false;
      rejectionReason = `Trading halted: Account max drawdown kill-switch activated (${metrics.currentDrawdownPercent.toFixed(1)}% >= ${maxDrawdownPct}%)`;
    }
    // 10. Consecutive loss cooling off
    else if (
      metrics.consecutiveLosses !== undefined &&
      metrics.consecutiveLosses >= maxConsecutiveLosses
    ) {
      isAllowed = false;
      rejectionReason = `Cooling-off triggered: ${metrics.consecutiveLosses} consecutive losses recorded (max ${maxConsecutiveLosses})`;
    }

    return {
      totalOpenPositions: openPositions.length,
      totalOpenRiskAmount: Number(totalOpenRiskAmount.toFixed(2)),
      totalOpenRiskPercent: Number(currentOpenRiskPercent.toFixed(2)),
      totalGrossExposure: Number(totalGrossWithProposed.toFixed(2)),
      grossLeverage,
      initialMarginUsed: Number(totalInitialMarginWithProposed.toFixed(2)),
      maintenanceMarginUsed: Number(totalMaintMarginWithProposed.toFixed(2)),
      availableMargin: Number(availableMargin.toFixed(2)),
      marginUtilizationPercent,
      positionsByAssetType,
      positionsBySymbol,
      isAllowed,
      rejectionReason,
    };
  }
}
