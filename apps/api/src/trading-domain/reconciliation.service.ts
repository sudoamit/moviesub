import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IReconciliationDomainService,
  PositionReconciliationResult,
  AccountReconciliationResult,
  OrderReconciliationResult,
  FullAuditReport,
  RemediationResult,
  JournalReconciliationResult,
  BrokerOrderReport,
  BrokerReconciliationResult,
  PositionState,
  OrderState,
  TradeLifecycleState,
  Direction,
} from '@quant/shared';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class ReconciliationService implements IReconciliationDomainService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  public async reconcilePosition(positionId: string): Promise<PositionReconciliationResult> {
    const pos = await this.prisma.paperPosition.findUnique({
      where: { id: positionId },
      include: {
        fills: true,
        trades: true,
      },
    });

    if (!pos) {
      return {
        positionId,
        isConsistent: false,
        storedQuantity: 0,
        projectedQuantityFromFills: 0,
        storedStatus: 'NOT_FOUND',
        hasJournal: false,
        orderCount: 0,
        fillCount: 0,
        anomalies: ['Position does not exist in database'],
      };
    }

    const anomalies: string[] = [];
    const fills = pos.fills || [];

    let totalEntryQty = 0;
    let totalExitQty = 0;

    for (const f of fills) {
      const q = Number(f.fillQuantity);
      if (f.executionRole === 'ENTRY' || !f.executionRole) {
        totalEntryQty += q;
      } else {
        totalExitQty += q;
      }
    }

    const projectedQty = Number(Math.max(0, totalEntryQty - totalExitQty).toFixed(4));
    const storedQty = Number(pos.quantity);

    if (Math.abs(storedQty - projectedQty) > 1e-4) {
      anomalies.push(
        `Quantity discrepancy: stored quantity (${storedQty}) does not match projected quantity from fills (${projectedQty}). Entry fills: ${totalEntryQty}, Exit fills: ${totalExitQty}`,
      );
    }

    const hasJournal = pos.trades && pos.trades.length > 0;
    if (pos.status === PositionState.CLOSED && !hasJournal) {
      anomalies.push(`Position is marked CLOSED but lacks a canonical PaperTrade journal entry`);
    }

    if (pos.status === PositionState.CLOSED && projectedQty > 0) {
      anomalies.push(`Position is marked CLOSED but fills ledger still projects open quantity (${projectedQty})`);
    }

    const isConsistent = anomalies.length === 0;

    return {
      positionId,
      isConsistent,
      storedQuantity: storedQty,
      projectedQuantityFromFills: projectedQty,
      storedStatus: pos.status,
      hasJournal,
      orderCount: pos.orderId ? 1 : 0,
      fillCount: fills.length,
      anomalies,
    };
  }

  public async reconcileAccount(accountId: string): Promise<AccountReconciliationResult> {
    const account = await this.prisma.paperAccount.findUnique({ where: { id: accountId } });
    const anomalies: string[] = [];

    if (!account) {
      return {
        accountId,
        isConsistent: false,
        cashBalance: 0,
        usedMargin: 0,
        activePositionsMarginSum: 0,
        marginDiscrepancy: 0,
        anomalies: ['Account does not exist'],
      };
    }

    const activePositions = await this.prisma.paperPosition.findMany({
      where: {
        accountId,
        status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
      },
      select: { id: true, usedMargin: true },
    });

    const activePositionsMarginSum = Number(
      activePositions.reduce((sum, p) => sum + Number(p.usedMargin), 0).toFixed(2),
    );
    const storedUsedMargin = Number(account.usedMargin);
    const marginDiscrepancy = Number(Math.abs(storedUsedMargin - activePositionsMarginSum).toFixed(2));

    if (marginDiscrepancy > 0.05) {
      anomalies.push(
        `Margin lock drift: Account stored usedMargin (₹${storedUsedMargin}) !== sum of active positions usedMargin (₹${activePositionsMarginSum}). Discrepancy: ₹${marginDiscrepancy}`,
      );
    }

    const cash = Number(account.cashBalance);
    if (!Number.isFinite(cash)) {
      anomalies.push(`Account cash balance is non-finite: ${account.cashBalance}`);
    }

    const isConsistent = anomalies.length === 0;

    return {
      accountId,
      isConsistent,
      cashBalance: cash,
      usedMargin: storedUsedMargin,
      activePositionsMarginSum,
      marginDiscrepancy,
      anomalies,
    };
  }

  public async reconcileOrder(orderId: string): Promise<OrderReconciliationResult> {
    const order = await this.prisma.paperOrder.findUnique({
      where: { id: orderId },
      include: { fills: true },
    });

    if (!order) {
      return {
        orderId,
        isConsistent: false,
        requestedQuantity: 0,
        storedFilledQuantity: 0,
        actualFillQuantitySum: 0,
        storedStatus: 'NOT_FOUND',
        fillCount: 0,
        anomalies: ['Order does not exist in database'],
      };
    }

    const anomalies: string[] = [];
    const fills = order.fills || [];
    const actualFillQuantitySum = Number(
      fills.reduce((sum, f) => sum + Number(f.fillQuantity), 0).toFixed(4),
    );
    const storedFilledQuantity = Number(Number(order.filledQuantity).toFixed(4));
    const requestedQuantity = Number(Number(order.requestedQuantity).toFixed(4));

    if (Math.abs(storedFilledQuantity - actualFillQuantitySum) > 1e-4) {
      anomalies.push(
        `Order filledQuantity discrepancy: stored filledQuantity (${storedFilledQuantity}) !== actual fills sum (${actualFillQuantitySum})`,
      );
    }

    if (actualFillQuantitySum > requestedQuantity + 1e-4) {
      anomalies.push(
        `Overfill detected: actual fills sum (${actualFillQuantitySum}) exceeds requestedQuantity (${requestedQuantity})`,
      );
    }

    if (actualFillQuantitySum === 0 && order.status === OrderState.FILLED) {
      anomalies.push(`Order is marked FILLED but has 0 fills in ledger`);
    }

    if (actualFillQuantitySum >= requestedQuantity - 1e-4 && order.status !== OrderState.FILLED && order.status !== OrderState.CANCELLED) {
      anomalies.push(
        `Order is fully filled (${actualFillQuantitySum}/${requestedQuantity}) but status is '${order.status}' instead of FILLED`,
      );
    }

    const isConsistent = anomalies.length === 0;

    return {
      orderId,
      isConsistent,
      requestedQuantity,
      storedFilledQuantity,
      actualFillQuantitySum,
      storedStatus: order.status,
      fillCount: fills.length,
      anomalies,
    };
  }

  public async performFullAudit(accountId: string): Promise<FullAuditReport> {
    const accountResult = await this.reconcileAccount(accountId);

    const positions = await this.prisma.paperPosition.findMany({
      where: { accountId },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const positionResults: PositionReconciliationResult[] = [];
    for (const p of positions) {
      positionResults.push(await this.reconcilePosition(p.id));
    }

    const orders = await this.prisma.paperOrder.findMany({
      where: { accountId },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const orderResults: OrderReconciliationResult[] = [];
    for (const o of orders) {
      orderResults.push(await this.reconcileOrder(o.id));
    }

    let unresolvedExecutions: string[] = [];
    try {
      const strandedExecutions = await this.prisma.algoBotExecution.findMany({
        where: {
          failureReasonCode: 'RECONCILIATION_REQUIRED',
        },
        select: { id: true },
      });
      unresolvedExecutions = strandedExecutions.map((e) => e.id);
    } catch {
      // Ignored if model table not directly queried
    }

    const anomaliesCount =
      accountResult.anomalies.length +
      positionResults.reduce((sum, p) => sum + p.anomalies.length, 0) +
      orderResults.reduce((sum, o) => sum + o.anomalies.length, 0) +
      unresolvedExecutions.length;

    const healthScore = Math.max(0, 100 - anomaliesCount * 15);
    const isHealthy = anomaliesCount === 0;

    const remediationSuggestions: string[] = [];
    if (accountResult.marginDiscrepancy > 0.05) {
      remediationSuggestions.push(
        `Synchronize account usedMargin (drifting by ₹${accountResult.marginDiscrepancy}) using autoRemediateAccount`,
      );
    }
    const corruptPositions = positionResults.filter((p) => !p.isConsistent);
    if (corruptPositions.length > 0) {
      remediationSuggestions.push(
        `Synchronize ${corruptPositions.length} position quantities with immutable fills ledger projection`,
      );
    }
    if (unresolvedExecutions.length > 0) {
      remediationSuggestions.push(
        `Resolve ${unresolvedExecutions.length} stranded broker executions via ExecutionService.resolveReconciliation`,
      );
    }

    return {
      accountId,
      healthScore,
      isHealthy,
      accountResult,
      positionResults,
      orderResults,
      unresolvedExecutions,
      anomaliesCount,
      remediationSuggestions,
    };
  }

  public async autoRemediateAccount(accountId: string): Promise<RemediationResult> {
    const remediatedItems: string[] = [];
    const errors: string[] = [];
    let remediatedPositions = 0;
    let remediatedMarginDrift = false;

    try {
      // 1. Remediate Margin Drift
      const activePositions = await this.prisma.paperPosition.findMany({
        where: {
          accountId,
          status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
        },
        select: { id: true, usedMargin: true },
      });

      const actualMarginSum = Number(
        activePositions.reduce((sum, p) => sum + Number(p.usedMargin), 0).toFixed(2),
      );

      const account = await this.prisma.paperAccount.findUnique({ where: { id: accountId } });
      if (account) {
        const storedUsedMargin = Number(account.usedMargin);
        if (Math.abs(storedUsedMargin - actualMarginSum) > 0.01) {
          await this.prisma.paperAccount.update({
            where: { id: accountId },
            data: { usedMargin: new Decimal(actualMarginSum) },
          });
          remediatedMarginDrift = true;
          remediatedItems.push(
            `Account usedMargin recalibrated from ₹${storedUsedMargin} to ₹${actualMarginSum}`,
          );
        }
      }

      // 2. Remediate Position Quantities
      const allPositions = await this.prisma.paperPosition.findMany({
        where: { accountId },
        include: { fills: true },
      });

      for (const pos of allPositions) {
        let totalEntry = 0;
        let totalExit = 0;
        for (const f of pos.fills || []) {
          const q = Number(f.fillQuantity);
          if (f.executionRole === 'ENTRY' || !f.executionRole) totalEntry += q;
          else totalExit += q;
        }

        const projectedQty = Number(Math.max(0, totalEntry - totalExit).toFixed(4));
        const storedQty = Number(pos.quantity);

        if (Math.abs(storedQty - projectedQty) > 1e-4) {
          const updateData: any = { quantity: new Decimal(projectedQty) };
          if (projectedQty <= 1e-4 && pos.status !== PositionState.CLOSED) {
            updateData.status = PositionState.CLOSED;
            updateData.closedAt = new Date();
          }

          await this.prisma.paperPosition.update({
            where: { id: pos.id },
            data: updateData,
          });

          remediatedPositions++;
          remediatedItems.push(
            `Position '${pos.id}' quantity recalibrated from ${storedQty} to ${projectedQty} based on fills ledger`,
          );
        }
      }
    } catch (err: any) {
      errors.push(err.message || String(err));
    }

    return {
      success: errors.length === 0,
      remediatedPositions,
      remediatedMarginDrift,
      remediatedItems,
      errors,
    };
  }

  /**
   * Startup reconciliation sweep. Runs on application initialization to detect
   * corrupted states, orphaned executions, or margin drifts after restart.
   */
  public async runStartupReconciliation(): Promise<{ reconciledPositions: number; anomaliesFound: number }> {
    this.logger.log('Starting Authoritative Startup Reconciliation Sweep...');

    const activePositions = await this.prisma.paperPosition.findMany({
      where: { status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED, PositionState.CLOSING] } },
      select: { id: true },
    });

    let anomaliesFound = 0;
    for (const p of activePositions) {
      const res = await this.reconcilePosition(p.id);
      if (!res.isConsistent) {
        anomaliesFound += res.anomalies.length;
        this.logger.warn(`[RECONCILIATION ANOMALY] positionId=${p.id}: ${res.anomalies.join('; ')}`);
      }
    }

    // Reconcile primary accounts
    const accounts = await this.prisma.paperAccount.findMany({ select: { id: true } });
    for (const acc of accounts) {
      const accRes = await this.reconcileAccount(acc.id);
      if (!accRes.isConsistent) {
        anomaliesFound += accRes.anomalies.length;
        this.logger.warn(`[ACCOUNT MARGIN DRIFT] accountId=${acc.id}: ${accRes.anomalies.join('; ')}`);
      }
    }

    this.logger.log(
      `✓ [STARTUP RECONCILIATION COMPLETED] Reconciled ${activePositions.length} active positions across ${accounts.length} accounts. Anomalies: ${anomaliesFound}`,
    );

    return {
      reconciledPositions: activePositions.length,
      anomaliesFound,
    };
  }

  /**
   * Reconciles closed positions with canonical PaperTrade journal entries.
   * Detects missing or duplicate journal entries and automatically backfills
   * canonical records from the immutable fills ledger.
   */
  public async reconcileJournal(accountId?: string): Promise<JournalReconciliationResult> {
    const whereClause: any = {
      status: PositionState.CLOSED,
    };
    if (accountId) {
      whereClause.accountId = accountId;
    }

    const closedPositions = await this.prisma.paperPosition.findMany({
      where: whereClause,
      include: {
        trades: true,
        fills: true,
      },
    });

    let missingJournalCount = 0;
    let reconstructedJournals = 0;
    let duplicateJournals = 0;
    const anomalies: string[] = [];

    for (const pos of closedPositions) {
      const tradeCount = (pos.trades || []).length;
      if (tradeCount === 0) {
        missingJournalCount++;
        anomalies.push(`Position '${pos.id}' is CLOSED but has 0 PaperTrade records`);

        // Reconstruct canonical PaperTrade from fills ledger
        const fills = pos.fills || [];
        let entryQty = 0;
        let entryTurnover = 0;
        let exitQty = 0;
        let exitTurnover = 0;
        let totalFees = 0;
        let earliestFill = pos.createdAt;
        let latestFill = pos.closedAt || new Date();

        for (const f of fills) {
          const q = Number(f.fillQuantity);
          const p = Number(f.fillPrice);
          const fee = Number(f.fee || 0);
          totalFees += fee;

          if (f.executionRole === 'ENTRY' || !f.executionRole) {
            entryQty += q;
            entryTurnover += p * q;
            if (f.fillTimestamp && (!earliestFill || f.fillTimestamp < earliestFill)) {
              earliestFill = f.fillTimestamp;
            }
          } else {
            exitQty += q;
            exitTurnover += p * q;
            if (f.fillTimestamp && (!latestFill || f.fillTimestamp > latestFill)) {
              latestFill = f.fillTimestamp;
            }
          }
        }

        const effectiveQty = entryQty > 0 ? entryQty : Number(pos.quantity) || 1;
        const effectiveEntryPrice = entryQty > 0 ? entryTurnover / entryQty : Number(pos.entryPrice);
        const effectiveExitPrice = exitQty > 0 ? exitTurnover / exitQty : Number(pos.currentPrice || pos.entryPrice);
        const isBuy = pos.direction === Direction.BULLISH || (pos.direction as any) === 'BUY';
        const grossPnL = isBuy
          ? (effectiveExitPrice - effectiveEntryPrice) * effectiveQty
          : (effectiveEntryPrice - effectiveExitPrice) * effectiveQty;
        const netPnL = Number((grossPnL - totalFees).toFixed(2));

        try {
          await this.prisma.paperTrade.create({
            data: {
              accountId: pos.accountId,
              positionId: pos.id,
              symbol: pos.symbol,
              contractSymbol: pos.contractSymbol || pos.symbol,
              instrumentType: pos.instrumentType || 'SPOT',
              strike: pos.strike,
              optionType: pos.optionType,
              direction: pos.direction,
              quantity: new Decimal(effectiveQty),
              entryPrice: new Decimal(effectiveEntryPrice),
              exitPrice: new Decimal(effectiveExitPrice),
              realizedPnL: new Decimal(netPnL),
              realizedR: new Decimal(0),
              fees: new Decimal(totalFees),
              entryTime: earliestFill,
              exitTime: latestFill,
              exitReason: 'Reconciliation Backfill',
              correlationId: pos.correlationId || `recon_${Date.now()}`,
            },
          });
          reconstructedJournals++;
        } catch (err: any) {
          anomalies.push(`Failed to backfill journal for position '${pos.id}': ${err.message}`);
        }
      } else if (tradeCount > 1) {
        duplicateJournals += (tradeCount - 1);
        anomalies.push(`Position '${pos.id}' has ${tradeCount} duplicate PaperTrade records`);
      }
    }

    return {
      auditedPositions: closedPositions.length,
      missingJournalCount,
      reconstructedJournals,
      duplicateJournals,
      anomalies,
    };
  }

  /**
   * Authoritative Broker Reconciliation.
   * Compares database order state against external broker execution reports.
   * External execution is strictly authoritative:
   * - If broker reports FILLED while DB has SUBMITTED/ACKNOWLEDGED, DB state is updated
   *   with authoritative fills, position is opened, and the order is NEVER re-sent.
   * - If broker reports CANCELLED/REJECTED, DB state is synchronized and margin released.
   */
  public async reconcileWithBroker(report: BrokerOrderReport): Promise<BrokerReconciliationResult> {
    this.logger.log(
      `Reconciling order with external broker report: brokerOrderId=${report.brokerOrderId}, status=${report.status}, filledQty=${report.filledQuantity}`,
    );

    let order: any = null;
    if (report.orderId) {
      order = await this.prisma.paperOrder.findUnique({
        where: { id: report.orderId },
        include: { fills: true, positions: true },
      });
    }

    if (!order && report.clientOrderId) {
      order = await this.prisma.paperOrder.findFirst({
        where: {
          OR: [
            { idempotencyKey: report.clientOrderId },
            { correlationId: report.clientOrderId },
          ],
        },
        include: { fills: true, positions: true },
      });
    }

    if (!order && report.brokerOrderId) {
      order = await this.prisma.paperOrder.findFirst({
        where: {
          OR: [
            { idempotencyKey: report.brokerOrderId },
            { correlationId: report.brokerOrderId },
          ],
        },
        include: { fills: true, positions: true },
      });
    }

    if (!order) {
      return {
        brokerOrderId: report.brokerOrderId,
        actionTaken: 'NO_OP',
        orderStatus: 'UNKNOWN',
        fillsCreated: 0,
        positionUpdated: false,
        message: `Order not found in local system for brokerOrderId '${report.brokerOrderId}'`,
      };
    }

    if (report.status === 'FILLED') {
      const currentFilled = (order.fills || []).reduce(
        (sum: number, f: any) => sum + Number(f.fillQuantity),
        0,
      );

      if (order.status === OrderState.FILLED && Math.abs(currentFilled - report.filledQuantity) < 1e-4) {
        return {
          orderId: order.id,
          brokerOrderId: report.brokerOrderId,
          actionTaken: 'NO_OP',
          orderStatus: OrderState.FILLED,
          fillsCreated: 0,
          positionUpdated: false,
          message: 'Order and fills are already synchronized with broker',
        };
      }

      // External execution is authoritative: update DB state accordingly. NEVER resend order!
      let fillsCreated = 0;
      const fillTime = report.updatedAt ? new Date(report.updatedAt) : new Date();

      await this.prisma.$transaction(async (tx) => {
        // 1. Record executed broker fills if provided
        if (report.executedFills && report.executedFills.length > 0) {
          for (const bf of report.executedFills) {
            await tx.paperFill.create({
              data: {
                orderId: order.id,
                executionRole: 'ENTRY',
                fillPrice: new Decimal(bf.price),
                fillQuantity: new Decimal(bf.quantity),
                fee: new Decimal(bf.fee || 0),
                slippage: new Decimal(0),
                executionPriceSource: 'LIVE_TICK',
                liquidityType: 'TAKER',
                sourceTimestamp: bf.timestamp ? new Date(bf.timestamp) : fillTime,
                fillTimestamp: bf.timestamp ? new Date(bf.timestamp) : fillTime,
                correlationId: order.correlationId || `corr_${report.brokerOrderId}`,
              },
            });
            fillsCreated++;
          }
        } else {
          // If executedFills breakdown omitted, create authoritative single fill for delta quantity
          const deltaQty = report.filledQuantity - currentFilled;
          if (deltaQty > 0) {
            await tx.paperFill.create({
              data: {
                orderId: order.id,
                executionRole: 'ENTRY',
                fillPrice: new Decimal(report.averagePrice || Number(order.price)),
                fillQuantity: new Decimal(deltaQty),
                fee: new Decimal(0),
                slippage: new Decimal(0),
                executionPriceSource: 'LIVE_TICK',
                liquidityType: 'TAKER',
                sourceTimestamp: fillTime,
                fillTimestamp: fillTime,
                correlationId: order.correlationId || `corr_${report.brokerOrderId}`,
              },
            });
            fillsCreated++;
          }
        }

        // 2. Update PaperOrder to FILLED
        await tx.paperOrder.update({
          where: { id: order.id },
          data: {
            status: OrderState.FILLED,
            filledQuantity: new Decimal(report.filledQuantity),
            price: report.averagePrice ? new Decimal(report.averagePrice) : order.price,
            firstFillAt: order.firstFillAt || fillTime,
          },
        });

        // 3. Synchronize linked PaperPosition
        const linkedPosition =
          (order.positions && order.positions[0]) ||
          (await tx.paperPosition.findFirst({ where: { orderId: order.id } }));

        if (linkedPosition && linkedPosition.status === PositionState.PENDING) {
          await tx.paperPosition.update({
            where: { id: linkedPosition.id },
            data: {
              status: PositionState.OPEN,
              quantity: new Decimal(report.filledQuantity),
              entryPrice: report.averagePrice
                ? new Decimal(report.averagePrice)
                : linkedPosition.entryPrice,
              entryTime: fillTime,
              openedAt: fillTime,
              positionOpenedAt: fillTime,
            },
          });
        }

        // 4. Resolve matching AlgoBotExecution if pending reconciliation
        if (order.executionId) {
          try {
            await tx.algoBotExecution.updateMany({
              where: { id: order.executionId },
              data: {
                state: 'EXECUTED',
                completedAt: fillTime,
                failureReasonCode: null,
              },
            });
          } catch {
            // non-fatal if table/relation absent in mock
          }
        }

        // 5. Update TradeDecision lifecycle state
        if (order.tradeDecisionId) {
          await tx.tradeDecision.updateMany({
            where: { id: order.tradeDecisionId },
            data: {
              lifecycleState: TradeLifecycleState.POSITION_OPENED,
              fillTime,
              updatedAt: new Date(),
            },
          });
        }
      });

      return {
        orderId: order.id,
        brokerOrderId: report.brokerOrderId,
        actionTaken: 'UPDATED_LOCAL_STATE',
        orderStatus: OrderState.FILLED,
        fillsCreated,
        positionUpdated: true,
        message: 'Authoritative broker fill reconciled successfully. Local state synchronized; order not resent.',
      };
    }

    if (report.status === 'CANCELLED') {
      await this.prisma.$transaction(async (tx) => {
        await tx.paperOrder.update({
          where: { id: order.id },
          data: { status: OrderState.CANCELLED },
        });

        const linkedPosition =
          (order.positions && order.positions[0]) ||
          (await tx.paperPosition.findFirst({ where: { orderId: order.id } }));

        if (linkedPosition && linkedPosition.status === PositionState.PENDING) {
          await tx.paperPosition.update({
            where: { id: linkedPosition.id },
            data: { status: PositionState.INVALIDATED, closedAt: new Date() },
          });
        }

        if (order.executionId) {
          try {
            await tx.algoBotExecution.updateMany({
              where: { id: order.executionId },
              data: { state: 'CANCELLED', failedAt: new Date() },
            });
          } catch {}
        }
      });

      return {
        orderId: order.id,
        brokerOrderId: report.brokerOrderId,
        actionTaken: 'CANCELLED_LOCAL',
        orderStatus: OrderState.CANCELLED,
        fillsCreated: 0,
        positionUpdated: false,
        message: 'Order cancelled based on authoritative broker report',
      };
    }

    if (report.status === 'REJECTED') {
      await this.prisma.$transaction(async (tx) => {
        await tx.paperOrder.update({
          where: { id: order.id },
          data: { status: OrderState.REJECTED },
        });

        if (order.executionId) {
          try {
            await tx.algoBotExecution.updateMany({
              where: { id: order.executionId },
              data: { state: 'FAILED_FINAL', failedAt: new Date(), failureReason: 'Broker rejected order' },
            });
          } catch {}
        }
      });

      return {
        orderId: order.id,
        brokerOrderId: report.brokerOrderId,
        actionTaken: 'REJECTED_LOCAL',
        orderStatus: OrderState.REJECTED,
        fillsCreated: 0,
        positionUpdated: false,
        message: 'Order rejected based on authoritative broker report',
      };
    }

    return {
      orderId: order.id,
      brokerOrderId: report.brokerOrderId,
      actionTaken: 'NO_OP',
      orderStatus: order.status,
      fillsCreated: 0,
      positionUpdated: false,
      message: `No action required for broker status '${report.status}'`,
    };
  }

  /**
   * Periodic reconciliation sweep across active accounts, positions, and journal.
   */
  public async runPeriodicReconciliation(): Promise<{ auditedAccounts: number; anomaliesFound: number; remediated: boolean }> {
    this.logger.log('Running periodic reconciliation sweep across all accounts...');
    const accounts = await this.prisma.paperAccount.findMany({ where: { isActive: true }, select: { id: true } });
    let totalAnomalies = 0;
    let anyRemediated = false;

    for (const acc of accounts) {
      const audit = await this.performFullAudit(acc.id);
      if (!audit.isHealthy) {
        totalAnomalies += audit.anomaliesCount;
        const rem = await this.autoRemediateAccount(acc.id);
        if (rem.success && (rem.remediatedPositions > 0 || rem.remediatedMarginDrift)) {
          anyRemediated = true;
        }
      }
    }

    // Sweep journal for closed positions missing PaperTrade records
    const journalResult = await this.reconcileJournal();
    totalAnomalies += journalResult.missingJournalCount + journalResult.duplicateJournals;

    return {
      auditedAccounts: accounts.length,
      anomaliesFound: totalAnomalies,
      remediated: anyRemediated || journalResult.reconstructedJournals > 0,
    };
  }

  /**
   * Reconciliation after broker reconnect.
   * Inspects all in-flight orders and synchronizes filled states.
   */
  public async afterBrokerReconnect(brokerId?: string): Promise<{ inFlightOrdersChecked: number; reconciled: number }> {
    this.logger.log(`Executing reconciliation sweep after broker reconnect${brokerId ? ` for broker '${brokerId}'` : ''}...`);

    const inFlightOrders = await this.prisma.paperOrder.findMany({
      where: {
        status: { in: [OrderState.SUBMITTED, OrderState.ACKNOWLEDGED, OrderState.PARTIALLY_FILLED] },
      },
      include: { fills: true },
    });

    let reconciled = 0;
    for (const order of inFlightOrders) {
      const fillsSum = (order.fills || []).reduce((sum: number, f: any) => sum + Number(f.fillQuantity), 0);
      const reqQty = Number(order.requestedQuantity);
      if (fillsSum >= reqQty - 1e-4 && order.status !== OrderState.FILLED) {
        await this.prisma.paperOrder.update({
          where: { id: order.id },
          data: { status: OrderState.FILLED, filledQuantity: new Decimal(fillsSum) },
        });
        reconciled++;
      }
    }

    return {
      inFlightOrdersChecked: inFlightOrders.length,
      reconciled,
    };
  }

  /**
   * Reconciliation after uncertain execution (e.g. gateway timeout or socket disconnect).
   * Prevents duplicate order placement by either applying broker report or flagging RECONCILIATION_REQUIRED.
   */
  public async afterUncertainExecution(
    executionId: string,
    brokerReport?: BrokerOrderReport,
  ): Promise<BrokerReconciliationResult> {
    this.logger.log(`Reconciling uncertain execution '${executionId}'...`);

    if (brokerReport) {
      return this.reconcileWithBroker(brokerReport);
    }

    try {
      await this.prisma.algoBotExecution.updateMany({
        where: { id: executionId },
        data: {
          failureReasonCode: 'RECONCILIATION_REQUIRED',
          failureReason: 'Execution state uncertain after broker disconnect or gateway timeout',
          updatedAt: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.warn(`Could not flag execution '${executionId}': ${err.message}`);
    }

    return {
      orderId: undefined,
      brokerOrderId: 'UNKNOWN',
      actionTaken: 'UPDATED_LOCAL_STATE',
      orderStatus: 'RECONCILIATION_REQUIRED',
      fillsCreated: 0,
      positionUpdated: false,
      message: `Execution '${executionId}' flagged RECONCILIATION_REQUIRED to prevent duplicate placement.`,
    };
  }

  /**
   * Reconciliation after background worker recovery.
   * Sweeps positions stranded in CLOSING or lingering transition states.
   */
  public async afterWorkerRecovery(workerId?: string): Promise<{ positionsChecked: number; recovered: number }> {
    this.logger.log(`Executing state audit after worker recovery${workerId ? ` for worker '${workerId}'` : ''}...`);

    const stuckPositions = await this.prisma.paperPosition.findMany({
      where: {
        status: PositionState.CLOSING,
      },
      include: { trades: true },
    });

    let recovered = 0;
    for (const pos of stuckPositions) {
      if (pos.trades && pos.trades.length > 0) {
        await this.prisma.paperPosition.update({
          where: { id: pos.id },
          data: { status: PositionState.CLOSED, closedAt: pos.trades[0].exitTime || new Date() },
        });
        recovered++;
      } else {
        await this.prisma.paperPosition.update({
          where: { id: pos.id },
          data: { status: PositionState.OPEN },
        });
        recovered++;
      }
    }

    return {
      positionsChecked: stuckPositions.length,
      recovered,
    };
  }
}
