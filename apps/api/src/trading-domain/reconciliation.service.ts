import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IReconciliationDomainService,
  PositionReconciliationResult,
  AccountReconciliationResult,
  PositionState,
} from '@quant/shared';

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

    const hasJournal = (pos.trades && pos.trades.length > 0);
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
}
