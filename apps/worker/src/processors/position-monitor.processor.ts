import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  BULLMQ_QUEUES,
  Direction,
  PositionState,
  OrderState,
  WS_EVENTS,
  ExecutionPriceResolver,
  ExecutionPriceSource,
  ValidatedLiveTickerResult,
  buildAccountingSnapshot,
  getAuthoritativeInstrument,
  hasInstrument,
  PointInTimeCurrencyConverter,
  resolveMarginModel,
  ExecutionAggregator,
  IFillRecord,
} from '@quant/shared';
import { TradeAccountingEngine } from '@quant/risk-engine';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../redis.service';
import { TrailingEngine } from '@quant/trading-engine';
import { Decimal } from '@prisma/client/runtime/library';

@Processor(BULLMQ_QUEUES.POSITION_MONITORING)
export class PositionMonitorProcessor extends WorkerHost {
  private readonly logger = new Logger(PositionMonitorProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.debug(`[PositionMonitor] Evaluating active positions for job ${job.id}`);
    return this.evaluateActivePositions();
  }

  /**
   * Retrieves persisted trading system configuration.
   */
  private async getSystemConfig(): Promise<{
    maxMarketDataAgeSeconds: number;
    maxSlippageBps: number;
  } | null> {
    try {
      let config = await this.prisma.tradingSystemConfig.findUnique({
        where: { id: 'SYSTEM_DEFAULT' },
      });

      if (!config) {
        config = await this.prisma.tradingSystemConfig.create({
          data: {
            id: 'SYSTEM_DEFAULT',
            paperTradingEnabled: true,
            liveTradingEnabled: false,
            emergencyStop: false,
            maxDailyLossPercent: new Decimal(3.0),
            maxPositionRiskPercent: new Decimal(1.0),
            maxTotalExposurePercent: new Decimal(20.0),
            maxOpenPositions: 5,
            maxTradesPerDay: 20,
            maxConsecutiveLosses: 3,
            maxLeverage: new Decimal(5.0),
            maxSlippageBps: 50,
            maxMarketDataAgeSeconds: 5,
          },
        });
      }

      if (
        config &&
        typeof config.maxMarketDataAgeSeconds === 'number' &&
        typeof config.maxSlippageBps === 'number'
      ) {
        return {
          maxMarketDataAgeSeconds: config.maxMarketDataAgeSeconds,
          maxSlippageBps: config.maxSlippageBps,
        };
      }
      return null;
    } catch (err: any) {
      this.logger.error(`[PositionMonitor] Failed to load TradingSystemConfig: ${err?.message}`);
      return null;
    }
  }

  /**
   * Main evaluation loop for all open/partially closed positions across all paper accounts.
   */
  public async evaluateActivePositions(): Promise<{
    checked: number;
    closed: number;
    updated: number;
  }> {
    const config = await this.getSystemConfig();

    if (
      !config ||
      typeof config.maxMarketDataAgeSeconds !== 'number' ||
      typeof config.maxSlippageBps !== 'number'
    ) {
      this.logger.error(
        '[PositionMonitor] Failed to load TradingSystemConfig from database. Failing closed.',
      );
      return { checked: 0, closed: 0, updated: 0 };
    }

    const maxMarketDataAgeSeconds = config.maxMarketDataAgeSeconds;
    const maxSlippageBps = config.maxSlippageBps;

    const activePositions = await this.prisma.paperPosition.findMany({
      where: {
        status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED, PositionState.EXIT_PENDING] },
      },
      include: { account: true },
    });

    if (activePositions.length === 0) {
      return { checked: 0, closed: 0, updated: 0 };
    }

    let closedCount = 0;
    let updatedCount = 0;

    for (const pos of activePositions) {
      try {
        const liveTick = await this.resolveLivePrice(pos.symbol, maxMarketDataAgeSeconds);

        // Fail-closed: If live tick is null/stale/invalid, do NOT close or alter the position
        if (!liveTick || liveTick.price <= 0) {
          if (pos.status === PositionState.EXIT_PENDING) {
            this.logger.debug(
              `[PositionMonitor] Position ${pos.id} (${pos.symbol}) is EXIT_PENDING but waiting for a fresh live tick; remaining EXIT_PENDING.`,
            );
          }
          continue;
        }

        const livePrice = liveTick.price;
        const tickTimestamp = liveTick.timestamp;

        // If position was already EXIT_PENDING, attempt immediate close ONLY with the validated fresh live tick
        if (pos.status === PositionState.EXIT_PENDING) {
          await this.executeFullClose(
            pos,
            livePrice,
            'Exit Pending Completed on Next Tick',
            'MANUAL',
            tickTimestamp,
            maxSlippageBps,
          );
          closedCount++;
          continue;
        }

        const isClosed = await this.evaluatePositionTick(pos, livePrice, tickTimestamp, maxSlippageBps);
        if (isClosed) {
          closedCount++;
        } else {
          updatedCount++;
        }
      } catch (err: any) {
        this.logger.error(`Error evaluating position ${pos.id} (${pos.symbol}): ${err?.message}`);
      }
    }

    return { checked: activePositions.length, closed: closedCount, updated: updatedCount };
  }

  /**
   * Resolves execution/monitoring price exclusively from the live ticker cache: ticker:${SYMBOL}:live
   * NEVER queries PostgreSQL candles or candle caches.
   */
  private async resolveLivePrice(
    symbol: string,
    maxAgeSeconds: number,
  ): Promise<ValidatedLiveTickerResult | null> {
    const sym = symbol.toUpperCase();

    try {
      const cached = await this.redis.get(`ticker:${sym}:live`);
      if (!cached) {
        this.logger.debug(
          `[PositionMonitor] No live ticker cached under 'ticker:${sym}:live' for ${sym}; skipping evaluation`,
        );
        return null;
      }

      const validated = ExecutionPriceResolver.validateLiveTicker(cached, maxAgeSeconds);
      if (validated && validated.price > 0) {
        return validated;
      }

      this.logger.warn(
        `[PositionMonitor] Live tick for ${sym} is stale (> ${maxAgeSeconds}s) or invalid; skipping execution to fail closed`,
      );
      return null;
    } catch (err: any) {
      this.logger.error(`[PositionMonitor] Error resolving live tick for ${sym}: ${err?.message}`);
      return null;
    }
  }

  private calculateCharges(turnover: number, isCrypto: boolean) {
    if (isCrypto) {
      const brokerage = Number((turnover * 0.001).toFixed(2));
      return {
        brokerage,
        stt: 0,
        exchangeTurnover: 0,
        gst: 0,
        sebiTurnover: 0,
        totalCharges: brokerage,
      };
    }
    const brokerage = 20.0;
    const stt = Number((turnover * 0.000125).toFixed(2));
    const exchangeTurnover = Number((turnover * 0.0000345).toFixed(2));
    const gst = Number(((brokerage + exchangeTurnover) * 0.18).toFixed(2));
    const sebiTurnover = Number((turnover * 0.000001).toFixed(2));
    const totalCharges = Number(
      (brokerage + stt + exchangeTurnover + gst + sebiTurnover).toFixed(2),
    );
    return { brokerage, stt, exchangeTurnover, gst, sebiTurnover, totalCharges };
  }

  private async evaluatePositionTick(
    pos: any,
    livePrice: number,
    tickTimestamp?: Date,
    maxSlippageBps = 50,
  ): Promise<boolean> {
    const entryPrice = Number(pos.entryPrice);
    const quantity = Number(pos.quantity);
    const isBuy = pos.direction === Direction.BULLISH;
    const priceDiff = isBuy ? livePrice - entryPrice : entryPrice - livePrice;

    // Use ONLY persisted position values (never invent synthetic risk levels)
    const stopLoss = pos.stopLoss ? Number(pos.stopLoss) : undefined;
    const initialStopLoss = pos.initialStopLoss ? Number(pos.initialStopLoss) : stopLoss;
    const riskAnchor = initialStopLoss ?? stopLoss;

    // If no risk anchor exists, riskDistance is 0 and currentR is 0 (no synthetic fallback)
    const riskDistance = riskAnchor ? Math.abs(entryPrice - riskAnchor) : 0;
    const currentR = riskDistance > 0 ? Number((priceDiff / riskDistance).toFixed(2)) : 0;

    if (!riskAnchor) {
      this.logger.warn(
        `[PositionMonitor] Position ${pos.id} (${pos.symbol}) is missing persisted StopLoss; SL evaluation skipped without fabricating risk levels.`,
      );
    }

    // Track MAE / MFE
    const currentMFE = Math.max(
      Number(pos.maxFavorableExcursion || 0),
      priceDiff > 0 ? priceDiff : 0,
    );
    const currentMAE = Math.max(
      Number(pos.maxAdverseExcursion || 0),
      priceDiff < 0 ? Math.abs(priceDiff) : 0,
    );

    const posAgeMs = Date.now() - new Date(pos.openedAt).getTime();
    const minAgeMs = 3000;

    // Evaluate Trailing Stops & Breakeven Lock via TrailingEngine
    let newStopLoss = pos.stopLoss ? Number(pos.stopLoss) : undefined;
    let trailingStateJson = (pos.trailingStateJson as any) || undefined;

    if (
      initialStopLoss &&
      Number(initialStopLoss) > 0 &&
      pos.initialTarget1 &&
      Number(pos.initialTarget1) > 0 &&
      pos.initialTarget2 &&
      Number(pos.initialTarget2) > 0 &&
      entryPrice > 0
    ) {
      const trailing = TrailingEngine.evaluate(
        entryPrice,
        Number(initialStopLoss),
        Number(pos.initialTarget1),
        Number(pos.initialTarget2),
        livePrice,
        isBuy ? 'BULLISH' : 'BEARISH',
      );

      trailingStateJson = {
        stage: trailing.stage,
        stageBadge: trailing.stageBadge,
        currentStopLoss: trailing.currentStopLoss,
        isRiskFree: trailing.isRiskFree,
        partialBookedPercent: trailing.partialBookedPercent,
        recommendedAction: trailing.recommendedAction,
      };

      if (trailing.isRiskFree) {
        if (isBuy && trailing.currentStopLoss > (newStopLoss || 0)) {
          newStopLoss = trailing.currentStopLoss;
        } else if (!isBuy && trailing.currentStopLoss < (newStopLoss || Infinity)) {
          newStopLoss = trailing.currentStopLoss;
        }
      }
    }

    // 1. Check Stop Loss Trigger (ONLY if a valid persisted SL exists)
    let shouldClose = false;
    let exitReason = '';
    let outcomeClassification = 'MANUAL';

    if (newStopLoss && posAgeMs >= minAgeMs) {
      const isSLHit = isBuy ? livePrice <= newStopLoss : livePrice >= newStopLoss;
      if (isSLHit) {
        shouldClose = true;
        exitReason = trailingStateJson?.isRiskFree
          ? 'Breakeven / Trailing SL Triggered'
          : 'Stop Loss Hit (SL)';
        outcomeClassification = trailingStateJson?.isRiskFree ? 'BREAKEVEN' : 'LOSS_SL';
      }
    }

    // 2. Check Final TP3 (Runner) Trigger (ONLY if persisted target3 exists)
    const tp3 = pos.target3 ? Number(pos.target3) : undefined;
    if (!shouldClose && tp3 && posAgeMs >= minAgeMs) {
      const isTP3Hit = isBuy ? livePrice >= tp3 : livePrice <= tp3;
      if (isTP3Hit) {
        shouldClose = true;
        exitReason = 'Final Take Profit (TP3 Runner) Achieved';
        outcomeClassification = 'WIN_TP3_RUNNER';
      }
    }

    if (shouldClose) {
      const isClosed = await this.executeFullClose(
        pos,
        livePrice,
        exitReason,
        outcomeClassification,
        tickTimestamp,
        maxSlippageBps,
      );
      return isClosed;
    }

    // Update ongoing unrealized P&L, MFE/MAE, and trailing stop in PostgreSQL
    const entryCharges = (pos.chargesJson as any) || { totalCharges: 0 };
    const unrealizedPnL = Number((priceDiff * quantity - entryCharges.totalCharges).toFixed(2));

    await this.prisma.paperPosition.update({
      where: { id: pos.id },
      data: {
        currentPrice: new Decimal(livePrice),
        stopLoss: newStopLoss ? new Decimal(newStopLoss) : undefined,
        unrealizedPnL: new Decimal(unrealizedPnL),
        unrealizedR: new Decimal(currentR),
        maxFavorableExcursion: new Decimal(currentMFE),
        maxAdverseExcursion: new Decimal(currentMAE),
        trailingStopStateJson: trailingStateJson,
      },
    });

    return false;
  }

  private async executeFullClose(
    pos: any,
    exitPrice: number,
    exitReason: string,
    outcomeClassification: string,
    sourceTimestamp?: Date,
    maxSlippageBps = 50,
  ): Promise<boolean> {
    // Apply exit slippage simulation within configured maxSlippageBps
    const isBuy = pos.direction === Direction.BULLISH;
    const slip = ExecutionPriceResolver.calculateSlippage(
      exitPrice,
      isBuy ? 'SELL' : 'BUY',
      maxSlippageBps,
    );
    const finalExitPrice = slip.fillPrice;

    const exitTime = new Date();
    const tickSourceTime = sourceTimestamp || exitTime;
    const isCrypto = pos.symbol === 'BTCUSDT';
    const quantity = Number(pos.quantity);
    const entryPrice = Number(pos.entryPrice);
    const exitTurnover = finalExitPrice * quantity;
    const exitCharges = this.calculateCharges(exitTurnover, isCrypto);
    const entryCharges = (pos.chargesJson as any) || { totalCharges: 0 };
    const totalCharges = Number((entryCharges.totalCharges + exitCharges.totalCharges).toFixed(2));

    const priceDiff = isBuy ? finalExitPrice - entryPrice : entryPrice - finalExitPrice;
    const grossPnL = priceDiff * quantity;
    const realizedPnL = Number((grossPnL - totalCharges).toFixed(2));

    // Zero synthetic risk: use only persisted SL
    const stopLoss = pos.stopLoss ? Number(pos.stopLoss) : undefined;
    const initialStopLoss = pos.initialStopLoss ? Number(pos.initialStopLoss) : stopLoss;
    const riskAnchor = initialStopLoss ?? stopLoss;
    const riskDistance = riskAnchor ? Math.abs(entryPrice - riskAnchor) : 0;
    const realizedR = riskDistance > 0 ? Number((priceDiff / riskDistance).toFixed(2)) : 0;
    const holdingDurationSeconds = Math.max(
      0,
      Math.floor((exitTime.getTime() - new Date(pos.openedAt).getTime()) / 1000),
    );

    let closedSuccessfully = false;

    await this.prisma.$transaction(async (tx) => {
      // 1. Atomic state transition: OPEN/EXIT_PENDING/PARTIALLY_CLOSED -> CLOSING (Double-Close Guard)
      const lockResult = await tx.paperPosition.updateMany({
        where: {
          id: pos.id,
          status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED, PositionState.EXIT_PENDING] },
        },
        data: {
          status: PositionState.CLOSING,
        },
      });

      if (lockResult.count === 0) {
        // Concurrency check: another worker/thread already closed this position!
        const existingTrade = await tx.paperTrade.findFirst({
          where: { positionId: pos.id },
          orderBy: { exitTime: 'desc' },
        });
        if (existingTrade) {
          this.logger.debug(
            `[PositionMonitor] Position ${pos.id} is already closed (trade: ${existingTrade.id}); idempotent close recognized.`,
          );
          return;
        }
        this.logger.warn(
          `[PositionMonitor] Position ${pos.id} is already CLOSING or CLOSED by another thread/worker; skipping duplicate close.`,
        );
        return;
      }

      // 2. Create Exit PaperOrder
      const exitOrder = await tx.paperOrder.create({
        data: {
          accountId: pos.accountId,
          symbol: pos.symbol,
          contractSymbol: pos.contractSymbol,
          instrumentType: pos.instrumentType,
          strike: pos.strike,
          optionType: pos.optionType,
          direction: isBuy ? Direction.BEARISH : Direction.BULLISH,
          orderType: 'MARKET',
          requestedQuantity: pos.quantity,
          filledQuantity: pos.quantity,
          price: new Decimal(finalExitPrice),
          status: OrderState.FILLED,
          idempotencyKey: `exit_worker_${pos.id}_${Date.now()}`,
          correlationId: pos.correlationId || `corr_${Date.now()}`,
          submittedAt: exitTime,
        },
      });

      // 3. Create Exit PaperFill
      const exitFill = await tx.paperFill.create({
        data: {
          orderId: exitOrder.id,
          fillPrice: new Decimal(finalExitPrice),
          fillQuantity: pos.quantity,
          fee: new Decimal(exitCharges.totalCharges),
          feeBreakdownJson: exitCharges,
          slippage: new Decimal(slip.slippageAmount),
          executionPriceSource: ExecutionPriceSource.LIVE_TICK,
          liquidityType: 'TAKER',
          sourceTimestamp: tickSourceTime,
          fillTimestamp: exitTime,
          correlationId: pos.correlationId || `corr_${Date.now()}`,
        },
      });

      // 4. Retrieve Entry Fills for Execution Aggregation (Strict: No Fabricated Fills)
      let entryFills: IFillRecord[] = [];
      if (pos.orderId && tx.paperFill) {
        const rawFills = await tx.paperFill.findMany({ where: { orderId: pos.orderId } });
        entryFills = (rawFills || []).map((f: any) => ({
          fillId: f.id,
          orderId: f.orderId,
          positionId: pos.id,
          executionRole: 'ENTRY' as const,
          fillPrice: Number(f.fillPrice),
          fillQuantity: Number(f.fillQuantity),
          fillTimestamp: f.fillTimestamp,
          fee: Number(f.fee),
          slippage: Number(f.slippage),
          executionPriceSource: f.executionPriceSource,
          sourceTimestamp: f.sourceTimestamp,
        }));
      }

      const exitFillRecord: IFillRecord = {
        fillId: exitFill.id,
        orderId: exitOrder.id,
        positionId: pos.id,
        executionRole: 'EXIT',
        fillPrice: finalExitPrice,
        fillQuantity: Number(pos.quantity),
        fillTimestamp: exitTime,
        fee: exitCharges.totalCharges,
        slippage: slip.slippageAmount,
        executionPriceSource: ExecutionPriceSource.LIVE_TICK,
        sourceTimestamp: tickSourceTime,
      };

      const hasAuthoritativeEntryFills = entryFills.length > 0;
      let aggregated: {
        entry: any;
        exit: any;
        durationMs: number | null;
        durationMinutes: number | null;
      };
      let isLegacyExecutionData = false;
      let executionDataComplete = true;

      if (hasAuthoritativeEntryFills) {
        aggregated = ExecutionAggregator.aggregateTradeLifecycle(entryFills, [exitFillRecord]);
      } else {
        // STRICT: Zero fabricated fill records. Missing entry execution represented strictly as null.
        // Duration is unknown and must not be calculated from unverified position dates.
        isLegacyExecutionData = true;
        executionDataComplete = false;
        const exitLeg = ExecutionAggregator.aggregateLeg([exitFillRecord], 'EXIT');
        aggregated = {
          entry: null,
          exit: exitLeg,
          durationMs: null,
          durationMinutes: null,
        };
      }

      // 5. Immutable Opening Accounting Snapshot & Canonical P&L
      const inst = getAuthoritativeInstrument(pos.symbol);
      const quoteCurrency = inst.currency;
      const openingSnapshot =
        (pos.executionEventsJson as any)?.accountingSnapshot ??
        (pos.featureSnapshotJson as any)?.accountingSnapshot as any;

      const snapshot = openingSnapshot ?? buildAccountingSnapshot({
        accountCurrency: 'INR',
        quoteCurrency,
        fxResult: PointInTimeCurrencyConverter.getInstance().getRate(quoteCurrency, 'INR', exitTime.getTime()),
        contractSize: inst.contractSize ?? 1,
        lotSize: Number(pos.quantity),
        resolvedMarginModel: resolveMarginModel(inst, { requestedLeverage: Number(pos.leverage) || 1 }),
        calculatedAt: exitTime.getTime(),
      });

      const effectiveEntryPrice = aggregated.entry ? aggregated.entry.weightedPrice : Number(pos.entryPrice);
      const effectiveExitPrice = aggregated.exit.weightedPrice;

      const pnlCalc = TradeAccountingEngine.calculateTradePnl({
        entryPrice: effectiveEntryPrice,
        exitPrice: effectiveExitPrice,
        quantity: Number(pos.quantity),
        direction: isBuy ? Direction.BULLISH : Direction.BEARISH,
        accountingSnapshot: snapshot,
        fees: totalCharges,
      });

      const canonicalRealizedPnL = pnlCalc.netPnlAccount;
      const canonicalRealizedR =
        riskDistance > 0
          ? Number(((isBuy ? effectiveExitPrice - effectiveEntryPrice : effectiveEntryPrice - effectiveExitPrice) / riskDistance).toFixed(2))
          : 0;

      // 6. Mark position CLOSED
      await tx.paperPosition.update({
        where: { id: pos.id },
        data: {
          status: PositionState.CLOSED,
          closedAt: new Date(aggregated.exit.latestFillTimestamp),
          currentPrice: new Decimal(effectiveExitPrice),
          unrealizedPnL: new Decimal(0.0),
          unrealizedR: new Decimal(0.0),
        },
      });

      // 7. Persist PaperTrade record with canonical execution facts
      const posEntryDate = pos.entryTime ? (pos.entryTime instanceof Date ? pos.entryTime : new Date(pos.entryTime)) : ((pos as any).openedAt ? (new Date((pos as any).openedAt)) : new Date());
      const tradeRecord = await tx.paperTrade.create({
        data: {
          accountId: pos.accountId,
          positionId: pos.id,
          symbol: pos.symbol,
          contractSymbol: pos.contractSymbol,
          instrumentType: pos.instrumentType,
          strike: pos.strike,
          optionType: pos.optionType,
          direction: pos.direction,
          quantity: pos.quantity,
          entryPrice: new Decimal(effectiveEntryPrice),
          exitPrice: new Decimal(effectiveExitPrice),
          realizedPnL: new Decimal(canonicalRealizedPnL),
          realizedR: new Decimal(canonicalRealizedR),
          maxFavorableExcursion: pos.maxFavorableExcursion,
          maxAdverseExcursion: pos.maxAdverseExcursion,
          holdingDurationSeconds: aggregated.durationMs !== null ? Math.max(0, Math.floor(aggregated.durationMs / 1000)) : 0,
          entryTime: aggregated.entry ? new Date(aggregated.entry.earliestFillTimestamp) : posEntryDate,
          exitTime: new Date(aggregated.exit.latestFillTimestamp),
          exitReason,
          chargesJson: {
            entryCharges,
            exitCharges,
            totalCharges: Number((entryCharges.totalCharges + exitCharges.totalCharges).toFixed(2)),
          },
          featureSnapshotJson: (pos.featureSnapshotJson as any) || undefined,
          outcomeSnapshotJson: {
            executionPriceSource: ExecutionPriceSource.LIVE_TICK,
            sourceTimestamp: tickSourceTime.toISOString(),
            livePrice: exitPrice,
            exitPrice: effectiveExitPrice,
            entryPrice: effectiveEntryPrice,
            requestedEntryPrice: Number(pos.entryPrice),
            actualEntryPrice: aggregated.entry ? aggregated.entry.weightedPrice : null,
            actualEntryPriceCurrency: aggregated.entry ? snapshot.quoteCurrency : null,
            entryTimeUtc: aggregated.entry ? aggregated.entry.earliestFillTimeUtc : null,
            actualExitPrice: aggregated.exit.weightedPrice,
            actualExitPriceCurrency: snapshot.quoteCurrency,
            exitTimeUtc: new Date(aggregated.exit.latestFillTimestamp).toISOString(),
            slippageBps: slip.slippageBps,
            slippageAmount: slip.slippageAmount,
            exitReason,
            realizedPnL: canonicalRealizedPnL,
            quotePnl: pnlCalc.quotePnl,
            quoteCurrency: snapshot.quoteCurrency,
            netPnlAccount: pnlCalc.netPnlAccount,
            accountCurrency: snapshot.accountCurrency,
            accountingSnapshot: snapshot as any,
            accountingSnapshotHash: snapshot.snapshotHash,
            realizedR: canonicalRealizedR,
            holdingDurationSeconds: aggregated.durationMs !== null ? Math.max(0, Math.floor(aggregated.durationMs / 1000)) : null,
            durationMs: aggregated.durationMs,
            durationMinutes: aggregated.durationMinutes,
            entryFillCount: aggregated.entry ? aggregated.entry.fillCount : 0,
            exitFillCount: aggregated.exit.fillCount,
            isLegacyExecutionData,
            executionDataComplete,
            outcomeClassification,
            exitTime: new Date(aggregated.exit.latestFillTimestamp).toISOString(),
            correlationId: pos.correlationId || `corr_${Date.now()}`,
          },
          outcomeClassification,
          correlationId: pos.correlationId || `corr_${Date.now()}`,
        },
      });

      // 8. Update PaperAccount Balance & Release Margin with Exact Cash Parity
      // Lifecycle Cash Delta: (-entryCharges) + (grossPnlAccount - exitCharges) = grossPnlAccount - totalCharges = netPnlAccount
      const canonicalCashImpact = Number((pnlCalc.grossPnlAccount - exitCharges.totalCharges).toFixed(2));
      await tx.paperAccount.update({
        where: { id: pos.accountId },
        data: {
          cashBalance: { increment: canonicalCashImpact },
          usedMargin: { decrement: Number(pos.usedMargin || 0) },
          realizedPnL: { increment: canonicalRealizedPnL },
          totalChargesPaid: { increment: exitCharges.totalCharges },
        },
      });

      // 9. Audit Log
      await tx.auditEvent.create({
        data: {
          actor: 'WORKER',
          service: 'POSITION_MONITOR',
          eventType: 'POSITION_CLOSED',
          entityType: 'TRADE',
          entityId: tradeRecord.id,
          payloadJson: {
            contractSymbol: pos.contractSymbol,
            entryPrice: effectiveEntryPrice,
            exitPrice: effectiveExitPrice,
            actualEntryPrice: aggregated.entry ? aggregated.entry.weightedPrice : null,
            actualExitPrice: effectiveExitPrice,
            executionPriceSource: ExecutionPriceSource.LIVE_TICK,
            sourceTimestamp: tickSourceTime.toISOString(),
            slippageBps: slip.slippageBps,
            slippageAmount: slip.slippageAmount,
            realizedPnL: canonicalRealizedPnL,
            quotePnl: pnlCalc.quotePnl,
            quoteCurrency: snapshot.quoteCurrency,
            accountCurrency: snapshot.accountCurrency,
            snapshotHash: snapshot.snapshotHash,
            realizedR: canonicalRealizedR,
            durationMs: aggregated.durationMs,
            isLegacyExecutionData,
            executionDataComplete,
            exitReason,
          },
          correlationId: pos.correlationId || `corr_${Date.now()}`,
        },
      });

      closedSuccessfully = true;
    });

    if (!closedSuccessfully) {
      return false;
    }

    this.logger.log(
      `✓ [POSITION MONITOR CLOSED] ${pos.contractSymbol} @ ₹${finalExitPrice.toFixed(2)} | Net PnL: ₹${realizedPnL.toFixed(2)} (${realizedR}R) [${exitReason}]`,
    );

    // Publish WebSocket notification
    const redisClient = this.redis.getClient();
    if (redisClient && redisClient.status === 'ready') {
      await redisClient.publish(
        WS_EVENTS.PAPER_POSITION_CLOSED,
        JSON.stringify({
          positionId: pos.id,
          contractSymbol: pos.contractSymbol,
          exitPrice: finalExitPrice,
          realizedPnL,
          realizedR,
          exitReason,
          closedAt: exitTime.toISOString(),
        }),
      );
    }

    return true;
  }
}

