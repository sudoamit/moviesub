import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IRiskDomainService,
  RiskCheckResult,
  RiskEvaluationParams,
  PositionState,
  OrderState,
} from '@quant/shared';

@Injectable()
export class RiskService implements IRiskDomainService {
  private readonly logger = new Logger(RiskService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Helper to compute start of day in an explicit timezone (e.g. Asia/Kolkata or UTC).
   */
  private getStartOfDay(timezone = 'UTC'): Date {
    const now = new Date();
    // Use Intl to get local date components in desired timezone
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.format(now); // "YYYY-MM-DD"
    // Parse midnight UTC of that calendar date
    const midnight = new Date(`${parts}T00:00:00.000Z`);
    return isNaN(midnight.getTime()) ? new Date(new Date().setUTCHours(0, 0, 0, 0)) : midnight;
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
  ): Promise<RiskCheckResult> {
    const startOfDay = this.getStartOfDay(timezone);
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

  public async checkMaxConsecutiveLosses(accountId: string, maxLimit: number): Promise<RiskCheckResult> {
    const recentTrades = await this.prisma.paperTrade.findMany({
      where: { accountId },
      orderBy: { exitTime: 'desc' },
      take: maxLimit,
      select: { realizedPnL: true },
    });

    // Loss semantics: PnL < 0 is a loss. PnL === 0 is breakeven (not a loss).
    if (
      recentTrades.length >= maxLimit &&
      recentTrades.every((t) => Number(t.realizedPnL) < 0)
    ) {
      return {
        allowed: false,
        reasonCode: 'MAX_CONSECUTIVE_LOSSES',
        message: `Maximum consecutive losses limit reached (${maxLimit} consecutive losses). Cool-off triggered.`,
        currentValue: recentTrades.length,
        limitValue: maxLimit,
      };
    }
    return { allowed: true, currentValue: recentTrades.length, limitValue: maxLimit };
  }

  public async checkMaxDailyLoss(
    accountId: string,
    maxDailyLossPercent: number,
    initialCapital: number,
    timezone = 'Asia/Kolkata',
  ): Promise<RiskCheckResult> {
    const startOfDay = this.getStartOfDay(timezone);
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
        message: `Daily loss limit breached: Realized ₹${todayRealizedPnL.toFixed(2)} exceeds max daily loss ₹${maxDailyLossAllowed.toFixed(2)} (${maxDailyLossPercent}%)`,
        currentValue: todayRealizedPnL,
        limitValue: -maxDailyLossAllowed,
      };
    }
    return { allowed: true, currentValue: todayRealizedPnL, limitValue: -maxDailyLossAllowed };
  }

  public checkPositionRisk(riskAmount: number, maxRiskAmount: number): RiskCheckResult {
    if (riskAmount > maxRiskAmount + 1e-4) {
      return {
        allowed: false,
        reasonCode: 'POSITION_RISK_LIMIT',
        message: `Position risk (₹${riskAmount.toFixed(2)}) exceeds allowable limit (₹${maxRiskAmount.toFixed(2)})`,
        currentValue: riskAmount,
        limitValue: maxRiskAmount,
      };
    }
    return { allowed: true, currentValue: riskAmount, limitValue: maxRiskAmount };
  }

  public checkExposureLimit(projectedExposure: number, maxExposureAllowed: number): RiskCheckResult {
    if (projectedExposure > maxExposureAllowed + 1e-4) {
      return {
        allowed: false,
        reasonCode: 'TOTAL_EXPOSURE_LIMIT',
        message: `Projected exposure (₹${projectedExposure.toFixed(2)}) exceeds maximum allowable limit (₹${maxExposureAllowed.toFixed(2)})`,
        currentValue: projectedExposure,
        limitValue: maxExposureAllowed,
      };
    }
    return { allowed: true, currentValue: projectedExposure, limitValue: maxExposureAllowed };
  }

  /**
   * Full composite risk evaluation for an incoming order.
   */
  public async evaluateOrderRisk(params: RiskEvaluationParams): Promise<RiskCheckResult> {
    const {
      accountId,
      requiredMargin,
      riskAmountAccount,
      riskTimezone = 'Asia/Kolkata',
    } = params;

    // Load account and system configuration
    const account = await this.prisma.paperAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      return { allowed: false, reasonCode: 'ACCOUNT_NOT_FOUND', message: 'Trading account not found' };
    }

    const config = await this.prisma.tradingSystemConfig.findUnique({ where: { id: 'SYSTEM_DEFAULT' } });
    if (config?.emergencyStop) {
      return { allowed: false, reasonCode: 'EMERGENCY_STOP', message: 'Trading halted by Emergency Stop Kill Switch' };
    }

    const maxOpen = config?.maxOpenPositions ?? 5;
    const openCheck = await this.checkMaxOpenPositions(accountId, maxOpen);
    if (!openCheck.allowed) return openCheck;

    const maxTrades = config?.maxTradesPerDay ?? 20;
    const tradesCheck = await this.checkMaxTradesPerDay(accountId, maxTrades, riskTimezone);
    if (!tradesCheck.allowed) return tradesCheck;

    const maxConsec = config?.maxConsecutiveLosses ?? 3;
    const consecCheck = await this.checkMaxConsecutiveLosses(accountId, maxConsec);
    if (!consecCheck.allowed) return consecCheck;

    const initialCapital = Number(account.initialCapital);
    const maxPosRiskPercent = Number(config?.maxPositionRiskPercent ?? 1.0);
    const maxRiskAmount = initialCapital * (maxPosRiskPercent / 100);
    const posRiskCheck = this.checkPositionRisk(riskAmountAccount, maxRiskAmount);
    if (!posRiskCheck.allowed) return posRiskCheck;

    const maxDailyLossPercent = Number(config?.maxDailyLossPercent ?? 3.0);
    const dailyCheck = await this.checkMaxDailyLoss(accountId, maxDailyLossPercent, initialCapital, riskTimezone);
    if (!dailyCheck.allowed) return dailyCheck;

    // Concurrency exposure check
    const maxExposurePercent = Number(config?.maxTotalExposurePercent ?? 20.0);
    const maxExposureAllowed = initialCapital * (maxExposurePercent / 100);
    const activePositions = await this.prisma.paperPosition.findMany({
      where: {
        accountId,
        status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
      },
      select: { usedMargin: true },
    });
    const currentUsedMargin = activePositions.reduce((sum, p) => sum + Number(p.usedMargin), 0);
    const projectedExposure = currentUsedMargin + requiredMargin;
    const exposureCheck = this.checkExposureLimit(projectedExposure, maxExposureAllowed);
    if (!exposureCheck.allowed) return exposureCheck;

    return { allowed: true };
  }
}
