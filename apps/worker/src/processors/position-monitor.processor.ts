import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { BULLMQ_QUEUES, Direction, PositionState, WS_EVENTS, ExecutionPriceResolver, ExecutionPriceSource, ValidatedLiveTickerResult } from '@quant/shared';
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
   * Main evaluation loop for all open/partially closed positions across all paper accounts.
   */
  public async evaluateActivePositions(): Promise<{
    checked: number;
    closed: number;
    updated: number;
  }> {
    const config = await this.prisma.tradingSystemConfig.findUnique({
      where: { id: 'SYSTEM_DEFAULT' },
    });

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
    const minAgeMs = 3000; // Minimum 3s to prevent race condition exits

    // Trailing stop evaluation: ONLY if all required persisted values exist (entry, initial SL, TP1, TP2)
    let newStopLoss = pos.stopLoss ? Number(pos.stopLoss) : undefined;
    let trailingStateJson: any = undefined;

    if (
      initialStopLoss &&
      pos.initialTarget1 &&
      pos.initialTarget2 &&
      Number(pos.initialTarget1) > 0 &&
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
      await this.executeFullClose(
        pos,
        livePrice,
        exitReason,
        outcomeClassification,
        tickTimestamp,
        maxSlippageBps,
      );
      return true;
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
  ) {
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
        this.logger.warn(
          `[PositionMonitor] Position ${pos.id} is already CLOSING or CLOSED by another thread/worker; skipping duplicate close.`,
        );
        return;
      }

      // 2. Mark position CLOSED
      await tx.paperPosition.update({
        where: { id: pos.id },
        data: {
          status: PositionState.CLOSED,
          closedAt: exitTime,
          currentPrice: new Decimal(finalExitPrice),
          unrealizedPnL: new Decimal(0.0),
          unrealizedR: new Decimal(0.0),
        },
      });

      // 3. Persist PaperTrade record
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
          entryPrice: pos.entryPrice,
          exitPrice: new Decimal(finalExitPrice),
          realizedPnL: new Decimal(realizedPnL),
          realizedR: new Decimal(realizedR),
          maxFavorableExcursion: pos.maxFavorableExcursion,
          maxAdverseExcursion: pos.maxAdverseExcursion,
          holdingDurationSeconds,
          entryTime: pos.entryTime,
          exitTime,
          exitReason,
          chargesJson: { entryCharges, exitCharges, totalCharges },
          featureSnapshotJson: (pos.featureSnapshotJson as any) || undefined,
          outcomeSnapshotJson: {
            executionPriceSource: ExecutionPriceSource.LIVE_TICK,
            sourceTimestamp: tickSourceTime.toISOString(),
            livePrice: exitPrice,
            exitPrice: finalExitPrice,
            slippageBps: slip.slippageBps,
            exitReason,
            realizedPnL,
            realizedR,
            holdingDurationSeconds,
            outcomeClassification,
            exitTime: exitTime.toISOString(),
          },
          outcomeClassification,
          correlationId: pos.correlationId || `corr_${Date.now()}`,
        },
      });

      // 4. Update PaperAccount Balance & Release Margin
      await tx.paperAccount.update({
        where: { id: pos.accountId },
        data: {
          cashBalance: { increment: grossPnL - exitCharges.totalCharges },
          usedMargin: { decrement: Number(pos.usedMargin) },
          realizedPnL: { increment: realizedPnL },
          totalChargesPaid: { increment: exitCharges.totalCharges },
        },
      });

      // 5. Audit Log
      await tx.auditEvent.create({
        data: {
          actor: 'WORKER',
          service: 'POSITION_MONITOR',
          eventType: 'POSITION_CLOSED',
          entityType: 'TRADE',
          entityId: tradeRecord.id,
          payloadJson: {
            contractSymbol: pos.contractSymbol,
            entryPrice,
            exitPrice: finalExitPrice,
            executionPriceSource: ExecutionPriceSource.LIVE_TICK,
            sourceTimestamp: tickSourceTime.toISOString(),
            realizedPnL,
            realizedR,
            exitReason,
          },
          correlationId: pos.correlationId || `corr_${Date.now()}`,
        },
      });

      closedSuccessfully = true;
    });

    if (!closedSuccessfully) {
      return;
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
  }
}

