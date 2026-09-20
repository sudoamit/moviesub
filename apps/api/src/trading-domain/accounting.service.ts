import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IAccountingDomainService,
  RealizedPnLCalculationParams,
  RealizedPnLCalculationResult,
  AccountLedgerDelta,
  Direction,
} from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class AccountingService implements IAccountingDomainService {
  private readonly logger = new Logger(AccountingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Calculates realized P&L strictly derived from actual fill execution prices and fees.
   * Never calculates final P&L from planned or theoretical prices.
   */
  public calculateRealizedPnL(params: RealizedPnLCalculationParams): RealizedPnLCalculationResult {
    const {
      direction,
      entryPrice,
      exitPrice,
      quantity,
      contractSize = 1,
      fxRate = 1.0,
      entryFees = 0,
      exitFees = 0,
      funding = 0,
    } = params;

    const isBuy = direction === Direction.BULLISH || direction === 'BUY' || direction === 'LONG';
    const priceDiff = isBuy ? exitPrice - entryPrice : entryPrice - exitPrice;

    const grossPnLQuote = priceDiff * quantity * contractSize;
    const grossPnLAccount = Number((grossPnLQuote * fxRate).toFixed(2));
    const totalCharges = Number((entryFees + exitFees + funding).toFixed(2));
    const netPnLAccount = Number((grossPnLAccount - totalCharges).toFixed(2));

    // Cash delta: grossPnL - exitFees - funding (entryFees were already subtracted at order entry)
    const cashDelta = Number((grossPnLAccount - exitFees - funding).toFixed(2));

    return {
      grossPnLQuote,
      grossPnLAccount,
      totalCharges,
      netPnLAccount,
      cashDelta,
    };
  }

  public calculateUnrealizedPnL(
    direction: Direction | string,
    entryPrice: number,
    currentPrice: number,
    quantity: number,
    contractSize = 1,
    fxRate = 1.0,
  ): number {
    const isBuy = direction === Direction.BULLISH || direction === 'BUY' || direction === 'LONG';
    const priceDiff = isBuy ? currentPrice - entryPrice : entryPrice - currentPrice;
    const unrealizedQuote = priceDiff * quantity * contractSize;
    return Number((unrealizedQuote * fxRate).toFixed(2));
  }

  /**
   * Applies an atomic financial ledger delta to a trading account.
   */
  public async applyAccountDelta(accountId: string, delta: AccountLedgerDelta): Promise<any> {
    const { cashBalanceDelta, usedMarginDelta, realizedPnLDelta, chargesDelta } = delta;

    // Validate no NaN or Infinity reaches DB
    this.assertFinite(cashBalanceDelta, 'cashBalanceDelta');
    this.assertFinite(usedMarginDelta, 'usedMarginDelta');
    this.assertFinite(realizedPnLDelta, 'realizedPnLDelta');
    this.assertFinite(chargesDelta, 'chargesDelta');

    const updateData: any = {};
    if (cashBalanceDelta !== 0) updateData.cashBalance = { increment: new Decimal(cashBalanceDelta) };
    if (usedMarginDelta !== 0) updateData.usedMargin = { increment: new Decimal(usedMarginDelta) };
    if (realizedPnLDelta !== 0) updateData.realizedPnL = { increment: new Decimal(realizedPnLDelta) };
    if (chargesDelta !== 0) updateData.totalChargesPaid = { increment: new Decimal(chargesDelta) };

    const updated = await this.prisma.paperAccount.update({
      where: { id: accountId },
      data: updateData,
    });

    this.assertFinancialInvariants(updated);
    return updated;
  }

  /**
   * Enforces critical financial invariants. Rejects NaN, Infinity, and invalid balances.
   */
  public assertFinancialInvariants(account: any): void {
    const cash = Number(account.cashBalance);
    const usedMargin = Number(account.usedMargin);
    const realizedPnL = Number(account.realizedPnL);
    const totalCharges = Number(account.totalChargesPaid);

    this.assertFinite(cash, 'cashBalance');
    this.assertFinite(usedMargin, 'usedMargin');
    this.assertFinite(realizedPnL, 'realizedPnL');
    this.assertFinite(totalCharges, 'totalChargesPaid');

    if (usedMargin < -1e-4) {
      throw new BadRequestException(`FINANCIAL_INVARIANT_BREACH: usedMargin cannot be negative (got ${usedMargin})`);
    }
  }

  private assertFinite(val: number, name: string): void {
    if (!Number.isFinite(val) || Number.isNaN(val)) {
      throw new BadRequestException(`FINANCIAL_INVARIANT_BREACH: ${name} must be a finite number. Got: ${val}`);
    }
  }
}
