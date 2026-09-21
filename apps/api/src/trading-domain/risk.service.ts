import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IRiskDomainService,
  RiskCheckResult,
  RiskEvaluationParams,
  TradeRiskCalculation,
  PortfolioRiskSnapshot,
  PositionState,
  OrderState,
} from '@quant/shared';
import { CircuitBreakerService } from './circuit-breaker.service';

@Injectable()
export class RiskService implements IRiskDomainService {
  private readonly logger = new Logger(RiskService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly circuitBreakerService?: CircuitBreakerService,
  ) {}

  /**
   * Computes the exact UTC Date corresponding to 00:00:00 local time
   * in the specified risk timezone (e.g. 'Asia/Kolkata' or 'UTC').
   * Guarantees zero lookahead and avoids relying on host/server timezone.
   */
  public getStartOfDay(timezone = 'Asia/Kolkata', referenceTime: Date = new Date()): Date {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const dateStr = formatter.format(referenceTime); // "YYYY-MM-DD"
    const [year, month, day] = dateStr.split('-').map(Number);

    // Create a UTC date at midnight
    const utcMidnight = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

    // Determine timezone offset at that date by formatting
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(utcMidnight);

    const getP = (type: string) => parts.find((p) => p.type === type)?.value;
    const tzHour = Number(getP('hour') ?? 0);
    const tzMin = Number(getP('minute') ?? 0);

    const offsetMs = (tzHour * 60 + tzMin) * 60000;
    return new Date(utcMidnight.getTime() - offsetMs);
  }

  /**
   * Authoritatively calculates exact trade risk, notional exposure, and margin required.
   * Strictly separates Notional Exposure, Margin, and Risk.
   */
  public calculateTradeRisk(params: {
    entryPrice: number;
    stopLoss?: number;
    quantity: number;
    contractSize?: number;
    fxRate?: number;
    leverage?: number;
    marginMode?: string;
    accountEquity: number;
  }): TradeRiskCalculation {
    const {
      entryPrice,
      stopLoss,
      quantity,
      contractSize = 1,
      fxRate = 1.0,
      leverage = 1,
      marginMode = 'SPOT',
      accountEquity,
    } = params;

    // 1. Notional Exposure: gross market value of the contract
    const tradeNotional = Number((quantity * entryPrice * contractSize * fxRate).toFixed(2));

    // 2. Margin Required: capital locked to support position
    const effLeverage = marginMode === 'SPOT' ? 1 : Math.max(1, leverage);
    const marginRequired = Number((tradeNotional / effLeverage).toFixed(2));

    // 3. Trade Risk: capital at hazard if stop loss is hit
    let tradeRiskAmount: number;
    if (stopLoss !== undefined && Number.isFinite(stopLoss) && stopLoss > 0) {
      const stopDistance = Math.abs(entryPrice - stopLoss);
      tradeRiskAmount = Number((stopDistance * quantity * contractSize * fxRate).toFixed(2));
    } else {
      // If no stop loss, full margin (or notional for spot) is at risk
      tradeRiskAmount = marginMode === 'SPOT' ? tradeNotional : marginRequired;
    }

    const tradeRiskPercent =
      accountEquity > 0 ? Number(((tradeRiskAmount / accountEquity) * 100).toFixed(2)) : 100;

    return {
      tradeRiskAmount,
      tradeRiskPercent,
      tradeNotional,
      marginRequired,
    };
  }

  /**
   * Authoritatively computes aggregated portfolio risk, total notional exposure,
   * total used margin, and daily risk across open positions.
   */
  public async calculatePortfolioRisk(
    accountId: string,
    timezone = 'Asia/Kolkata',
    referenceTime: Date = new Date(),
  ): Promise<PortfolioRiskSnapshot> {
    const activePositions = await this.prisma.paperPosition.findMany({
      where: {
        accountId,
        status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
      },
    });

    let totalNotionalExposure = 0;
    let totalUsedMargin = 0;
    let openPositionRisk = 0;
    let unrealizedLossSum = 0;

    for (const pos of activePositions) {
      const qty = Number(pos.quantity);
      const currPrice = Number(pos.currentPrice || pos.entryPrice);
      const stopLoss = pos.stopLoss ? Number(pos.stopLoss) : undefined;
      const margin = Number(pos.usedMargin);
      const unPnL = Number(pos.unrealizedPnL || 0);

      const notional = qty * currPrice;
      totalNotionalExposure += notional;
      totalUsedMargin += margin;

      if (stopLoss !== undefined && stopLoss > 0) {
        const stopDistance = Math.abs(currPrice - stopLoss);
        openPositionRisk += stopDistance * qty;
      } else {
        openPositionRisk += margin;
      }

      if (unPnL < 0) {
        unrealizedLossSum += Math.abs(unPnL);
      }
    }

    // Daily realized loss in explicit timezone
    const startOfDay = this.getStartOfDay(timezone, referenceTime);
    const todayTrades = await this.prisma.paperTrade.findMany({
      where: {
        accountId,
        exitTime: { gte: startOfDay },
      },
      select: { realizedPnL: true },
    });

    let dailyRealizedLoss = 0;
    for (const t of todayTrades) {
      const pnl = Number(t.realizedPnL || 0);
      if (pnl < 0) {
        dailyRealizedLoss += Math.abs(pnl);
      }
    }

    const dailyRisk = Number((dailyRealizedLoss + unrealizedLossSum).toFixed(2));

    return {
      openPositionRisk: Number(openPositionRisk.toFixed(2)),
      openPositionCount: activePositions.length,
      totalNotionalExposure: Number(totalNotionalExposure.toFixed(2)),
      totalUsedMargin: Number(totalUsedMargin.toFixed(2)),
      dailyRealizedLoss: Number(dailyRealizedLoss.toFixed(2)),
      dailyRisk,
    };
  }

  public async checkMaxOpenPositions(accountId: string, maxLimit: number): Promise<RiskCheckResult> {
    const count = await this.prisma.paperPosition.count({
      where: {
        accountId,
        status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
      },
    });

    if (count >= maxLimit) {
      return {
        allowed: false,
        reasonCode: 'MAX_OPEN_POSITIONS',
        message: `Maximum open positions limit reached (${count} >= ${maxLimit})`,
        currentValue: count,
        limitValue: maxLimit,
      };
    }
    return { allowed: true, currentValue: count, limitValue: maxLimit };
  }

  public async checkMaxTradesPerDay(
    accountId: string,
    maxLimit: number,
    timezone = 'Asia/Kolkata',
    referenceTime: Date = new Date(),
  ): Promise<RiskCheckResult> {
    const startOfDay = this.getStartOfDay(timezone, referenceTime);
    const count = await this.prisma.paperOrder.count({
      where: {
        accountId,
        createdAt: { gte: startOfDay },
        status: { in: [OrderState.FILLED, OrderState.SUBMITTED, OrderState.PARTIALLY_FILLED] },
      },
    });

    if (count >= maxLimit) {
      return {
        allowed: false,
        reasonCode: 'MAX_TRADES_PER_DAY',
        message: `Maximum trades per day reached (${count} >= ${maxLimit}) for timezone ${timezone}`,
        currentValue: count,
        limitValue: maxLimit,
      };
    }
    return { allowed: true, currentValue: count, limitValue: maxLimit };
  }

  /**
   * Loss semantics:
   * PnL < 0 -> LOSS
   * PnL = 0 -> BREAKEVEN (does not count as loss unless treatBreakevenAsLoss is true)
   * PnL > 0 -> WIN (resets consecutive loss count)
   */
  public async checkMaxConsecutiveLosses(
    accountId: string,
    maxLimit: number,
    treatBreakevenAsLoss = false,
  ): Promise<RiskCheckResult> {
    const recentTrades = await this.prisma.paperTrade.findMany({
      where: { accountId },
      orderBy: { exitTime: 'desc' },
      take: maxLimit * 3, // take enough buffer to evaluate consecutive streak
      select: { realizedPnL: true },
    });

    let consecutiveLosses = 0;
    for (const t of recentTrades) {
      const pnl = Number(t.realizedPnL || 0);
      if (pnl < 0) {
        consecutiveLosses++;
        if (consecutiveLosses >= maxLimit) break;
      } else if (pnl === 0) {
        if (treatBreakevenAsLoss) {
          consecutiveLosses++;
          if (consecutiveLosses >= maxLimit) break;
        }
        // Breakeven does not count as a loss and does not reset streak
      } else {
        // PnL > 0: WIN resets streak
        break;
      }
    }

    if (consecutiveLosses >= maxLimit) {
      return {
        allowed: false,
        reasonCode: 'MAX_CONSECUTIVE_LOSSES',
        message: `Maximum consecutive losses limit reached (${consecutiveLosses} consecutive losses). Cool-off triggered.`,
        currentValue: consecutiveLosses,
        limitValue: maxLimit,
      };
    }
    return { allowed: true, currentValue: consecutiveLosses, limitValue: maxLimit };
  }

  public async checkMaxDailyLoss(
    accountId: string,
    maxDailyLossPercent: number,
    initialCapital: number,
    timezone = 'Asia/Kolkata',
    referenceTime: Date = new Date(),
  ): Promise<RiskCheckResult> {
    const startOfDay = this.getStartOfDay(timezone, referenceTime);
    const todayTrades = await this.prisma.paperTrade.findMany({
      where: {
        accountId,
        exitTime: { gte: startOfDay },
      },
      select: { realizedPnL: true },
    });

    const todayRealizedPnL = todayTrades.reduce((sum, t) => sum + Number(t.realizedPnL || 0), 0);
    const maxDailyLossAllowed = initialCapital * (maxDailyLossPercent / 100);

    if (todayRealizedPnL < -maxDailyLossAllowed) {
      return {
        allowed: false,
        reasonCode: 'DAILY_LOSS_LIMIT',
        message: `Daily loss limit breached: Realized ₹${todayRealizedPnL.toFixed(2)} exceeds max daily loss ₹${maxDailyLossAllowed.toFixed(2)} (${maxDailyLossPercent}%) in timezone ${timezone}`,
        currentValue: todayRealizedPnL,
        limitValue: -maxDailyLossAllowed,
      };
    }
    return { allowed: true, currentValue: todayRealizedPnL, limitValue: -maxDailyLossAllowed };
  }

  public checkPositionRisk(riskAmount: number, maxRiskAmount: number): RiskCheckResult {
    return this.checkMaxRiskPerTrade(riskAmount, maxRiskAmount);
  }

  public checkMaxRiskPerTrade(tradeRiskAmount: number, maxRiskAmount: number): RiskCheckResult {
    if (tradeRiskAmount > maxRiskAmount + 1e-4) {
      return {
        allowed: false,
        reasonCode: 'MAX_RISK_PER_TRADE',
        message: `Trade risk (₹${tradeRiskAmount.toFixed(2)}) exceeds allowable limit (₹${maxRiskAmount.toFixed(2)})`,
        currentValue: tradeRiskAmount,
        limitValue: maxRiskAmount,
      };
    }
    return { allowed: true, currentValue: tradeRiskAmount, limitValue: maxRiskAmount };
  }

  public checkMaxPortfolioRisk(projectedPortfolioRisk: number, maxPortfolioRiskAllowed: number): RiskCheckResult {
    if (projectedPortfolioRisk > maxPortfolioRiskAllowed + 1e-4) {
      return {
        allowed: false,
        reasonCode: 'MAX_PORTFOLIO_RISK',
        message: `Projected portfolio risk (₹${projectedPortfolioRisk.toFixed(2)}) exceeds allowable limit (₹${maxPortfolioRiskAllowed.toFixed(2)})`,
        currentValue: projectedPortfolioRisk,
        limitValue: maxPortfolioRiskAllowed,
      };
    }
    return { allowed: true, currentValue: projectedPortfolioRisk, limitValue: maxPortfolioRiskAllowed };
  }

  public checkExposureLimit(projectedExposure: number, maxExposureAllowed: number): RiskCheckResult {
    return this.checkMaxTotalExposure(projectedExposure, maxExposureAllowed);
  }

  /**
   * Evaluates gross NOTIONAL EXPOSURE against portfolio notional limits.
   * Strictly separated from margin!
   */
  public checkMaxTotalExposure(projectedNotionalExposure: number, maxExposureAllowed: number): RiskCheckResult {
    if (projectedNotionalExposure > maxExposureAllowed + 1e-4) {
      return {
        allowed: false,
        reasonCode: 'TOTAL_EXPOSURE_LIMIT',
        message: `Projected notional exposure (₹${projectedNotionalExposure.toFixed(2)}) exceeds maximum allowable limit (₹${maxExposureAllowed.toFixed(2)})`,
        currentValue: projectedNotionalExposure,
        limitValue: maxExposureAllowed,
      };
    }
    return { allowed: true, currentValue: projectedNotionalExposure, limitValue: maxExposureAllowed };
  }

  /**
   * Evaluates MARGIN required against available account margin.
   * Strictly separated from notional exposure!
   */
  public checkMaxUsedMargin(projectedUsedMargin: number, maxMarginAllowed: number): RiskCheckResult {
    if (projectedUsedMargin > maxMarginAllowed + 1e-4) {
      return {
        allowed: false,
        reasonCode: 'MAX_USED_MARGIN',
        message: `Projected used margin (₹${projectedUsedMargin.toFixed(2)}) exceeds allowable margin (₹${maxMarginAllowed.toFixed(2)})`,
        currentValue: projectedUsedMargin,
        limitValue: maxMarginAllowed,
      };
    }
    return { allowed: true, currentValue: projectedUsedMargin, limitValue: maxMarginAllowed };
  }

  /**
   * Full composite risk evaluation for an incoming order.
   * Strictly evaluates tradeRisk, portfolioRisk, dailyRisk, openPositionRisk, and totalExposure.
   */
  public async evaluateOrderRisk(params: RiskEvaluationParams): Promise<RiskCheckResult> {
    const {
      accountId,
      symbol,
      entryPrice,
      stopLoss,
      quantity,
      contractSize = 1,
      requiredMargin,
      riskAmountAccount,
      riskTimezone = 'Asia/Kolkata',
      treatBreakevenAsLoss = false,
      fxRate = 1.0,
      leverage = 1,
    } = params;

    // 1. Load account and system configuration
    const account = await this.prisma.paperAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      return { allowed: false, reasonCode: 'ACCOUNT_NOT_FOUND', message: 'Trading account not found' };
    }

    // Check Multi-Tier Circuit Breakers (Global, Account, Instrument)
    if (this.circuitBreakerService) {
      const cbCheck = await this.circuitBreakerService.evaluateExecutionAllowed({
        action: 'ENTRY',
        accountId,
        symbol,
      });
      if (!cbCheck.allowed) {
        return {
          allowed: false,
          reasonCode: cbCheck.reasonCode || 'CIRCUIT_BREAKER_TRIGGERED',
          message: cbCheck.message,
        };
      }
    }

    const config = await this.prisma.tradingSystemConfig.findUnique({ where: { id: 'SYSTEM_DEFAULT' } });
    if (config?.emergencyStop) {
      return { allowed: false, reasonCode: 'EMERGENCY_STOP', message: 'Trading halted by Emergency Stop Kill Switch' };
    }

    const initialCapital = Number(account.initialCapital);

    // 2. Check Max Open Positions
    const maxOpen = config?.maxOpenPositions ?? 5;
    const openCheck = await this.checkMaxOpenPositions(accountId, maxOpen);
    if (!openCheck.allowed) return openCheck;

    // 3. Check Max Trades Per Day in explicit risk-day timezone
    const maxTrades = config?.maxTradesPerDay ?? 20;
    const tradesCheck = await this.checkMaxTradesPerDay(accountId, maxTrades, riskTimezone);
    if (!tradesCheck.allowed) return tradesCheck;

    // 4. Check Max Consecutive Losses (with explicit breakeven semantics)
    const maxConsec = config?.maxConsecutiveLosses ?? 3;
    const consecCheck = await this.checkMaxConsecutiveLosses(accountId, maxConsec, treatBreakevenAsLoss);
    if (!consecCheck.allowed) return consecCheck;

    // 5. Calculate Trade Risk
    const tradeRisk = this.calculateTradeRisk({
      entryPrice,
      stopLoss,
      quantity,
      contractSize,
      fxRate,
      leverage,
      accountEquity: initialCapital,
    });

    const effectiveRiskAmount = riskAmountAccount > 0 ? riskAmountAccount : tradeRisk.tradeRiskAmount;
    const effectiveNotional = params.notional ?? tradeRisk.tradeNotional;
    const effectiveMargin = requiredMargin > 0 ? requiredMargin : tradeRisk.marginRequired;

    // 6. Check Max Risk Per Trade
    const maxPosRiskPercent = Number(config?.maxPositionRiskPercent ?? 1.0);
    const maxRiskAmount = initialCapital * (maxPosRiskPercent / 100);
    const posRiskCheck = this.checkMaxRiskPerTrade(effectiveRiskAmount, maxRiskAmount);
    if (!posRiskCheck.allowed) return posRiskCheck;

    // 7. Check Max Daily Loss in explicit risk-day timezone
    const maxDailyLossPercent = Number(config?.maxDailyLossPercent ?? 3.0);
    const dailyCheck = await this.checkMaxDailyLoss(accountId, maxDailyLossPercent, initialCapital, riskTimezone);
    if (!dailyCheck.allowed) return dailyCheck;

    // 8. Snapshot Portfolio Risk
    const portfolioSnapshot = await this.calculatePortfolioRisk(accountId, riskTimezone);

    // 9. Check Max Portfolio Risk
    const maxPortfolioRiskPercent = 5.0; // 5% total portfolio risk cap
    const maxPortfolioRiskAllowed = initialCapital * (maxPortfolioRiskPercent / 100);
    const projectedPortfolioRisk = portfolioSnapshot.openPositionRisk + effectiveRiskAmount;
    const portfolioRiskCheck = this.checkMaxPortfolioRisk(projectedPortfolioRisk, maxPortfolioRiskAllowed);
    if (!portfolioRiskCheck.allowed) return portfolioRiskCheck;

    // 10. Check Max Total Notional Exposure (NOT margin!)
    const maxExposurePercent = Number(config?.maxTotalExposurePercent ?? 100.0);
    const maxExposureAllowed = initialCapital * (maxExposurePercent / 100);
    const projectedNotionalExposure = portfolioSnapshot.totalNotionalExposure + effectiveNotional;
    const exposureCheck = this.checkMaxTotalExposure(projectedNotionalExposure, maxExposureAllowed);
    if (!exposureCheck.allowed) return exposureCheck;

    // 11. Check Max Used Margin (NOT exposure!)
    const availableMargin = Number(account.cashBalance) - Number(account.usedMargin);
    const projectedUsedMargin = portfolioSnapshot.totalUsedMargin + effectiveMargin;
    const marginCheck = this.checkMaxUsedMargin(projectedUsedMargin, Number(account.cashBalance));
    if (!marginCheck.allowed) return marginCheck;

    return { allowed: true };
  }
}
