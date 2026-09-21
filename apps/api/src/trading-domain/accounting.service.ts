import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IAccountingDomainService,
  Lot,
  MatchedLot,
  LotMatchingResult,
  OutcomeClassification,
  RealizedPnLCalculationParams,
  RealizedPnLCalculationResult,
  PositionSettlementParams,
  PositionSettlementResult,
  AccountLedgerDelta,
  Direction,
} from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class AccountingService implements IAccountingDomainService {
  private readonly logger = new Logger(AccountingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Matches exit fills against open entry lots using FIFO or LIFO order.
   */
  public matchLots(
    entryLots: Lot[],
    exitQuantity: number,
    exitPrice: number,
    method: 'FIFO' | 'LIFO' = 'FIFO',
  ): LotMatchingResult {
    if (!Number.isFinite(exitQuantity) || exitQuantity <= 0) {
      throw new BadRequestException(
        `INVALID_LOT_MATCHING: exitQuantity must be a positive finite number (got ${exitQuantity})`,
      );
    }
    if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
      throw new BadRequestException(
        `INVALID_LOT_MATCHING: exitPrice must be a positive finite number (got ${exitPrice})`,
      );
    }

    let remainingExitQty = Number(exitQuantity.toFixed(8));
    const matchedLots: MatchedLot[] = [];
    const openLots: Lot[] = entryLots.map((l) => ({ ...l }));

    if (method === 'LIFO') {
      openLots.reverse();
    }

    const unconsumedLots: Lot[] = [];

    for (const lot of openLots) {
      if (remainingExitQty <= 1e-8) {
        unconsumedLots.push(lot);
        continue;
      }

      const matchQty = Math.min(lot.quantity, remainingExitQty);
      const grossPnLQuote = (exitPrice - lot.price) * matchQty;
      const entryFeesAllocated = lot.fees ? Number(((lot.fees * matchQty) / lot.quantity).toFixed(4)) : 0;

      matchedLots.push({
        lotId: lot.id,
        matchedQuantity: Number(matchQty.toFixed(8)),
        entryPrice: lot.price,
        exitPrice,
        grossPnLQuote: Number(grossPnLQuote.toFixed(4)),
        entryFeesAllocated,
      });

      remainingExitQty = Number((remainingExitQty - matchQty).toFixed(8));
      const remainingLotQty = Number((lot.quantity - matchQty).toFixed(8));

      if (remainingLotQty > 1e-8) {
        unconsumedLots.push({
          ...lot,
          quantity: remainingLotQty,
          fees: lot.fees ? Number((lot.fees - entryFeesAllocated).toFixed(4)) : undefined,
        });
      }
    }

    if (method === 'LIFO') {
      unconsumedLots.reverse();
    }

    const totalMatchedQuantity = matchedLots.reduce((acc, m) => acc + m.matchedQuantity, 0);
    const weightedEntryPrice =
      totalMatchedQuantity > 0
        ? Number(
            (
              matchedLots.reduce((acc, m) => acc + m.matchedQuantity * m.entryPrice, 0) /
              totalMatchedQuantity
            ).toFixed(6),
          )
        : 0;

    return {
      matchedLots,
      remainingLots: unconsumedLots,
      totalMatchedQuantity: Number(totalMatchedQuantity.toFixed(8)),
      weightedEntryPrice,
      exitPrice,
      unmatchedExitQuantity: Math.max(0, remainingExitQty),
    };
  }

  /**
   * Calculates realized P&L strictly derived from actual fill execution prices and fees.
   * Never calculates final P&L from planned or theoretical prices.
   * Multi-asset support: Spot, Perpetuals/Futures, Options.
   * Explicit loss semantics: LOSS (< 0), BREAKEVEN (== 0), WIN (> 0).
   */
  public calculateRealizedPnL(params: RealizedPnLCalculationParams): RealizedPnLCalculationResult {
    const {
      direction,
      entryPrice,
      exitPrice,
      quantity,
      contractSize = 1,
      fxRate = 1.0,
      fxSnapshot,
      entryFees = 0,
      exitFees = 0,
      funding = 0,
      slippage = 0,
      slippageIncludedInPrices = true,
      instrumentType = 'SPOT',
      optionType,
      initialRiskAccount,
      initialStopLoss,
    } = params;

    this.assertPositiveFinite(quantity, 'quantity');
    this.assertPositiveFinite(entryPrice, 'entryPrice');
    this.assertPositiveFinite(exitPrice, 'exitPrice');
    this.assertPositiveFinite(contractSize, 'contractSize');

    let effectiveFxRate = fxRate;
    if (fxSnapshot) {
      effectiveFxRate = fxSnapshot.rate;
    }
    this.assertPositiveFinite(effectiveFxRate, 'fxRate');

    const isBuy =
      direction === Direction.BULLISH ||
      direction === 'BUY' ||
      direction === 'LONG' ||
      direction === 'CALL';

    let legPriceDelta: number;
    if (instrumentType === 'OPTION') {
      // Options: buyers (LONG/BULLISH) profit when premium increases; sellers (SHORT/BEARISH) profit when premium decreases
      legPriceDelta = isBuy ? exitPrice - entryPrice : entryPrice - exitPrice;
    } else {
      // Spot / Perp / Futures: Long profits on price rise; Short profits on price fall
      legPriceDelta = isBuy ? exitPrice - entryPrice : entryPrice - exitPrice;
    }

    const grossPnLQuote = legPriceDelta * quantity * contractSize - funding;
    const grossPnLAccount = Number((grossPnLQuote * effectiveFxRate).toFixed(2));
    const totalCharges = Number((entryFees + exitFees).toFixed(2));

    const safeSlippage = Number.isFinite(slippage) ? Math.max(0, slippage) : 0;
    const unpricedSlippageAccountCost =
      slippageIncludedInPrices === false ? Number((safeSlippage * effectiveFxRate).toFixed(2)) : 0;

    let netPnLAccount = Number((grossPnLAccount - totalCharges - unpricedSlippageAccountCost).toFixed(2));
    if (Math.abs(netPnLAccount) < 1e-4) {
      netPnLAccount = 0.0;
    }

    // Explicit loss semantics
    let outcomeClassification: OutcomeClassification;
    if (netPnLAccount < -1e-4) {
      outcomeClassification = 'LOSS';
    } else if (netPnLAccount > 1e-4) {
      outcomeClassification = 'WIN';
    } else {
      outcomeClassification = 'BREAKEVEN';
    }

    // Realized R calculation: initialRiskAccount takes precedence, then initialStopLoss derivation
    let effectiveInitialRisk = initialRiskAccount;
    if (
      (effectiveInitialRisk === undefined || effectiveInitialRisk <= 0) &&
      initialStopLoss !== undefined &&
      initialStopLoss > 0
    ) {
      const stopDistance = Math.abs(entryPrice - initialStopLoss);
      effectiveInitialRisk = Number((stopDistance * quantity * contractSize * effectiveFxRate).toFixed(2));
    }

    let realizedR: number | undefined;
    if (effectiveInitialRisk && effectiveInitialRisk > 0) {
      realizedR = Number((netPnLAccount / effectiveInitialRisk).toFixed(2));
    } else if (Math.abs(netPnLAccount) < 1e-4) {
      realizedR = 0;
    }

    // Cash delta: grossPnL - exitFees (entryFees were already encumbered/subtracted at order entry)
    let cashDelta = Number((grossPnLAccount - exitFees - unpricedSlippageAccountCost).toFixed(2));
    if (Math.abs(cashDelta) < 1e-4) {
      cashDelta = 0.0;
    }

    return {
      grossPnLQuote: Number(grossPnLQuote.toFixed(4)),
      grossPnLAccount,
      totalCharges,
      netPnLAccount,
      realizedR,
      cashDelta,
      slippage: safeSlippage > 0 ? safeSlippage : undefined,
      fxSnapshot,
      outcomeClassification,
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
    const isBuy =
      direction === Direction.BULLISH ||
      direction === 'BUY' ||
      direction === 'LONG' ||
      direction === 'CALL';
    const legPriceDelta = isBuy ? currentPrice - entryPrice : entryPrice - currentPrice;
    const unrealizedQuote = legPriceDelta * quantity * contractSize;
    return Number((unrealizedQuote * fxRate).toFixed(2));
  }

  /**
   * Settles a specific execution leg (ENTRY, partial exit, or final exit).
   */
  public async settlePositionLeg(params: PositionSettlementParams): Promise<PositionSettlementResult> {
    const {
      accountId,
      role,
      direction,
      entryPrice,
      exitPrice,
      quantity,
      releasedMargin,
      instrumentType = 'SPOT',
      optionType,
      contractSize = 1,
      fxRate = 1.0,
      fxSnapshot,
      entryFees = 0,
      exitFees = 0,
      funding = 0,
      slippage = 0,
      slippageIncludedInPrices = true,
      initialRiskAccount,
      initialStopLoss,
      applyToAccount = true,
    } = params;

    let pnlResult: RealizedPnLCalculationResult;
    let ledgerDelta: AccountLedgerDelta;

    if (role === 'ENTRY') {
      const safeEntryFees = Number.isFinite(entryFees) ? entryFees : 0;
      pnlResult = {
        grossPnLQuote: 0,
        grossPnLAccount: 0,
        totalCharges: safeEntryFees,
        netPnLAccount: -safeEntryFees,
        cashDelta: -safeEntryFees,
        realizedR: 0,
        fxSnapshot,
        outcomeClassification: safeEntryFees > 0 ? 'LOSS' : 'BREAKEVEN',
      };
      ledgerDelta = {
        cashBalanceDelta: -safeEntryFees,
        usedMarginDelta: Number(releasedMargin.toFixed(2)), // in entry, releasedMargin is the requiredMargin added
        realizedPnLDelta: -safeEntryFees,
        chargesDelta: safeEntryFees,
      };
    } else {
      // Exit roles: TP1_PARTIAL, TP2_PARTIAL, FINAL_EXIT, STOP_LOSS, MANUAL_EXIT, etc.
      pnlResult = this.calculateRealizedPnL({
        direction,
        entryPrice,
        exitPrice,
        quantity,
        contractSize,
        fxRate,
        fxSnapshot,
        entryFees,
        exitFees,
        funding,
        slippage,
        slippageIncludedInPrices,
        instrumentType,
        optionType,
        initialRiskAccount,
        initialStopLoss,
      });

      ledgerDelta = {
        cashBalanceDelta: pnlResult.cashDelta,
        usedMarginDelta: -Number(releasedMargin.toFixed(2)), // released from encumbrance
        realizedPnLDelta: pnlResult.netPnLAccount,
        chargesDelta: Number((exitFees + funding).toFixed(2)),
      };
    }

    let accountUpdated: any;
    if (applyToAccount) {
      accountUpdated = await this.applyAccountDelta(accountId, ledgerDelta);
    }

    return {
      pnlResult,
      ledgerDelta,
      accountUpdated,
    };
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
    if (totalCharges < -1e-4) {
      throw new BadRequestException(
        `FINANCIAL_INVARIANT_BREACH: totalChargesPaid cannot be negative (got ${totalCharges})`,
      );
    }
  }

  private assertFinite(val: number, name: string): void {
    if (!Number.isFinite(val) || Number.isNaN(val)) {
      throw new BadRequestException(`FINANCIAL_INVARIANT_BREACH: ${name} must be a finite number. Got: ${val}`);
    }
  }

  private assertPositiveFinite(val: number, name: string): void {
    if (!Number.isFinite(val) || Number.isNaN(val) || val <= 0) {
      throw new BadRequestException(`FINANCIAL_INVARIANT_BREACH: ${name} must be a positive finite number. Got: ${val}`);
    }
  }
}

