import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PaperTradingService } from './paper-trading.service';
import { ExecutionMode } from './execution-provider.interface';
import {
  RealMarketStreamerService,
  QuoteProvenance,
  ILiveRealTicker,
} from '../market-data/real-market-streamer.service';
import { RedisService } from '../common/redis/redis.service';
import {
  Direction,
  PositionState,
  TradeLifecycleState,
  WS_EVENTS,
  getAuthoritativeInstrument,
  PointInTimeCurrencyConverter,
  parseAndValidateRedisOptionQuote,
  validateAuthoritativeExecutionQuote,
} from '@quant/shared';
import { TradeAccountingEngine } from '@quant/risk-engine';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class PaperPositionMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaperPositionMonitorService.name);
  private monitorTimer: NodeJS.Timeout | null = null;
  private isEvaluating = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly paperTradingService: PaperTradingService,
    private readonly realMarketStreamer: RealMarketStreamerService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  onModuleInit() {
    this.logger.log('Starting Independent Backend Paper Position Monitor Service...');
    // Run evaluation loop every 1.5 seconds independently of browser
    this.monitorTimer = setInterval(async () => {
      await this.evaluateActivePositions();
    }, 1500);
  }

  onModuleDestroy() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
  }

  /**
   * Main evaluation loop:
   * 1. Query all active OPEN and PARTIALLY_CLOSED positions from PostgreSQL
   * 2. For each position, match strictly by (symbol + direction + contractSymbol + positionId)
   * 3. Fetch validated live price for exact instrument
   * 4. Check TP/SL thresholds
   * 5. Perform atomic closure or partial scale-out
   */
  public async evaluateActivePositions() {
    if (this.isEvaluating) return;
    this.isEvaluating = true;

    try {
      const activePositions = await this.prisma.paperPosition.findMany({
        where: {
          status: { in: [PositionState.OPEN, PositionState.PARTIALLY_CLOSED] },
        },
      });

      if (activePositions.length === 0) {
        this.isEvaluating = false;
        return;
      }

      for (const pos of activePositions) {
        await this.evaluateSinglePosition(pos);
      }
    } catch (err: any) {
      this.logger.error(`Error in PaperPositionMonitorService: ${err.message}`, err.stack);
    } finally {
      this.isEvaluating = false;
    }
  }

  public async evaluateSinglePosition(pos: any) {
    const symbol = pos.symbol;
    const direction = pos.direction; // Direction.BULLISH or Direction.BEARISH
    const isBuy = direction === Direction.BULLISH;
    const isOption = pos.instrumentType === 'OPTION' || Boolean(pos.strike);

    // 1. Obtain Live Price for EXACT Executed Instrument
    let livePrice = 0;
    let marketEventTime = new Date();
    let provenance: QuoteProvenance = 'UNKNOWN';

    try {
      if (isOption) {
        // Options: fetch option contract quote for exact instrument contractSymbol
        const optionQuote = await this.getOptionContractQuote(pos);
        if (
          !optionQuote ||
          optionQuote.provenance !== 'LIVE_PROVIDER' ||
          optionQuote.price <= 0 ||
          !optionQuote.marketEventTime ||
          optionQuote.marketEventTime <= 0
        ) {
          // If exact option LTP is unavailable or missing marketEventTime, do NOT fall back. Fail closed.
          return;
        }
        livePrice = optionQuote.price;
        marketEventTime = new Date(optionQuote.marketEventTime);
        provenance = optionQuote.provenance;
      } else {
        // Spot or Crypto: fetch validated ticker
        const ticker = this.realMarketStreamer.getValidatedTicker(symbol, 5);
        if (
          !ticker ||
          ticker.provenance !== 'LIVE_PROVIDER' ||
          ticker.price <= 0 ||
          !ticker.marketEventTime ||
          ticker.marketEventTime <= 0
        ) {
          return;
        }
        livePrice = ticker.price;
        marketEventTime = new Date(ticker.marketEventTime);
        provenance = ticker.provenance;
      }
    } catch {
      // Stale or missing market data -> do NOT execute auto-close on stale data
      return;
    }

    if (livePrice <= 0 || provenance !== 'LIVE_PROVIDER') {
      return;
    }

    let currentStopLoss = pos.stopLoss ? Number(pos.stopLoss) : null;
    const target1 = pos.target1 ? Number(pos.target1) : null;
    const target2 = pos.target2 ? Number(pos.target2) : null;
    const target3 = pos.target3 ? Number(pos.target3) : null;
    const entryPrice = Number(pos.entryPrice);
    const existingEvents = (pos.executionEventsJson as any) || {};

    // 2. Evaluate Active Stop Loss Threshold FIRST (Full close remaining quantity)
    let isSLHit = false;
    if (currentStopLoss !== null) {
      if (isBuy && livePrice <= currentStopLoss) {
        isSLHit = true;
      } else if (!isBuy && livePrice >= currentStopLoss) {
        isSLHit = true;
      }
    }

    if (isSLHit) {
      const isBreakeven =
        existingEvents.currentStopLoss === entryPrice ||
        existingEvents.tp1FillTime ||
        currentStopLoss === entryPrice;
      const exitReason = isBreakeven ? 'Breakeven Stop Loss Hit' : 'Stop Loss Hit';

      this.logger.log(
        `🚨 [AUTO TP/SL MONITOR] SL Threshold Crossed for position '${pos.id}' (${pos.contractSymbol}): Live ${livePrice} vs SL ${currentStopLoss}. Triggering backend auto-close [${exitReason}]...`,
      );
      try {
        const completedTrade = await this.paperTradingService.closePosition(
          pos.id,
          exitReason,
          {
            triggerPrice: currentStopLoss!,
            triggerMarketEventTime: marketEventTime,
            exitPriceOverride: livePrice,
            allowPriceOverride: true,
            isInternalCall: true,
            executionMode: ExecutionMode.PAPER_MARKET,
            correlationId: pos.correlationId,
          },
        );

        await this.publishTradeClosedEvent(completedTrade);
        return;
      } catch (err: any) {
        this.logger.error(`Failed auto-closing position '${pos.id}' on SL: ${err.message}`);
        return;
      }
    }

    // 3. Evaluate TP1 Partial Scale-Out (Sequential Gating: TP1 must be evaluated if position has not filled TP1)
    let hasTP1 = Boolean(existingEvents.tp1FillTime);
    if (!hasTP1 && target1 !== null && pos.status === PositionState.OPEN) {
      let isTP1Hit = false;
      if (isBuy && livePrice >= target1) {
        isTP1Hit = true;
      } else if (!isBuy && livePrice <= target1) {
        isTP1Hit = true;
      }

      if (isTP1Hit) {
        this.logger.log(
          `✂️ [AUTO TP/SL MONITOR] TP1 Scale-Out Crossed for position '${pos.id}' (${pos.contractSymbol}): Live ${livePrice} vs Target1 ${target1}. Executing 30% partial close...`,
        );
        try {
          const tp1Result = await this.executePartialScaleOut(
            pos,
            'TP1',
            target1,
            livePrice,
            marketEventTime,
            0.3,
          );
          if (tp1Result) {
            hasTP1 = true;
            pos.status = PositionState.PARTIALLY_CLOSED;
            pos.quantity = tp1Result.remainingQuantity;
            pos.stopLoss = tp1Result.newStopLoss;
            currentStopLoss = tp1Result.newStopLoss;
            existingEvents.tp1FillTime = tp1Result.fillTimestamp;
            existingEvents.tp1Quantity = tp1Result.partialQty;
            existingEvents.partialLegs = tp1Result.partialLegs;
          }
        } catch (err: any) {
          this.logger.error(`Failed partial TP1 scale-out for position '${pos.id}': ${err.message}`);
        }
      }
    }

    // 4. Evaluate TP2 Scale-Out (Sequential Gating: TP2 CANNOT execute unless TP1 has completed)
    let hasTP2 = Boolean(existingEvents.tp2FillTime);
    if (hasTP1 && !hasTP2 && target2 !== null && pos.status === PositionState.PARTIALLY_CLOSED) {
      let isTP2Hit = false;
      if (isBuy && livePrice >= target2) {
        isTP2Hit = true;
      } else if (!isBuy && livePrice <= target2) {
        isTP2Hit = true;
      }

      if (isTP2Hit) {
        if (target3 !== null) {
          // If TP3 exists, execute canonical 30% TP2 partial scale-out
          this.logger.log(
            `✂️ [AUTO TP/SL MONITOR] TP2 Scale-Out Crossed for position '${pos.id}' (${pos.contractSymbol}): Live ${livePrice} vs Target2 ${target2}. Executing 30% partial close...`,
          );
          try {
            const tp2Result = await this.executePartialScaleOut(
              pos,
              'TP2',
              target2,
              livePrice,
              marketEventTime,
              0.3,
            );
            if (tp2Result) {
              hasTP2 = true;
              pos.quantity = tp2Result.remainingQuantity;
              pos.stopLoss = tp2Result.newStopLoss;
              currentStopLoss = tp2Result.newStopLoss;
              existingEvents.tp2FillTime = tp2Result.fillTimestamp;
              existingEvents.tp2Quantity = tp2Result.partialQty;
              existingEvents.partialLegs = tp2Result.partialLegs;
            }
          } catch (err: any) {
            this.logger.error(`Failed partial TP2 scale-out for position '${pos.id}': ${err.message}`);
          }
        } else {
          // If no target3 exists, target2 is final exit: close remaining quantity
          this.logger.log(
            `🎯 [AUTO TP/SL MONITOR] Target 2 Completed for position '${pos.id}' (${pos.contractSymbol}): Live ${livePrice} vs Target2 ${target2}. Triggering full close...`,
          );
          try {
            const completedTrade = await this.paperTradingService.closePosition(
              pos.id,
              'Target 2 Completed',
              {
                triggerPrice: target2,
                triggerMarketEventTime: marketEventTime,
                exitPriceOverride: livePrice,
                allowPriceOverride: true,
                isInternalCall: true,
                executionMode: ExecutionMode.PAPER_MARKET,
                correlationId: pos.correlationId,
              },
            );
            await this.publishTradeClosedEvent(completedTrade);
            return;
          } catch (err: any) {
            this.logger.error(`Failed closing position '${pos.id}' on TP2: ${err.message}`);
            return;
          }
        }
      }
    }

    // 5. Evaluate TP3 Full Close (Sequential Gating: TP3 CANNOT execute unless TP2 has completed)
    if (hasTP2 && target3 !== null && pos.status === PositionState.PARTIALLY_CLOSED) {
      let isTP3Hit = false;
      if (isBuy && livePrice >= target3) {
        isTP3Hit = true;
      } else if (!isBuy && livePrice <= target3) {
        isTP3Hit = true;
      }

      if (isTP3Hit) {
        this.logger.log(
          `🎯 [AUTO TP/SL MONITOR] Target 3 Completed for position '${pos.id}' (${pos.contractSymbol}): Live ${livePrice} vs Target3 ${target3}. Triggering final runner close...`,
        );
        try {
          const completedTrade = await this.paperTradingService.closePosition(
            pos.id,
            'Target 3 Completed',
            {
              triggerPrice: target3,
              triggerMarketEventTime: marketEventTime,
              exitPriceOverride: livePrice,
              allowPriceOverride: true,
              isInternalCall: true,
              executionMode: ExecutionMode.PAPER_MARKET,
              correlationId: pos.correlationId,
            },
          );
          await this.publishTradeClosedEvent(completedTrade);
          return;
        } catch (err: any) {
          this.logger.error(`Failed closing position '${pos.id}' on TP3: ${err.message}`);
          return;
        }
      }
    }
  }

  /**
   * Fetches real option contract quote object with genuine marketEventTime.
   */
  private async getOptionContractQuote(pos: any): Promise<ILiveRealTicker | null> {
    if (this.realMarketStreamer) {
      const optionTicker = this.realMarketStreamer.getOptionTicker(pos.contractSymbol);
      if (optionTicker && optionTicker.provenance === 'LIVE_PROVIDER' && optionTicker.price > 0) {
        return optionTicker;
      }
    }
    if (this.redis) {
      try {
        const cached = await this.redis.getClient().get(`option:ltp:${pos.contractSymbol}`);
        if (cached) {
          const parsedObj = JSON.parse(cached);
          const providerId = parsedObj.providerId;
          const providerTransport = parsedObj.providerTransport;
          let activeConn: any = null;
          try {
            if (providerId && providerTransport) {
              activeConn = this.realMarketStreamer?.getCurrentProviderConnection(
                providerId,
                providerTransport,
              );
            }
          } catch {}
          const isStreamerHealthy =
            providerId && providerTransport && this.realMarketStreamer
              ? this.realMarketStreamer.isExecutionDataHealthy(providerTransport, providerId)
              : false;

          const validation = parseAndValidateRedisOptionQuote(
            cached,
            pos.contractSymbol,
            activeConn || 0,
            isStreamerHealthy,
            Date.now(),
          );

          if (validation.valid && validation.quote) {
            return validation.quote as ILiveRealTicker;
          }

          // If Redis record fails canonical validation, parse minimal fields for DEGRADED representation
          // but NEVER elevate to LIVE_PROVIDER authority!
          const parsed = JSON.parse(cached);
          const rawEventTime = parsed.marketEventTime;
          const eventTime = rawEventTime ? Number(rawEventTime) : undefined;
          if (parsed.price > 0 && eventTime) {
            return {
              symbol: pos.contractSymbol,
              price: parsed.price,
              open: parsed.open,
              high: parsed.high,
              low: parsed.low,
              close: parsed.close ?? parsed.price,
              volume: parsed.volume,
              prevClose: parsed.prevClose,
              changePercent: parsed.changePercent,
              changeAmount: parsed.changeAmount,
              tickSize: getAuthoritativeInstrument(pos.symbol)?.tickSize ?? undefined,
              volatility: parsed.volatility,
              lastUpdated: parsed.timestamp || Date.now(),
              provenance: 'DEGRADED',
              marketEventTime: eventTime,
              connectionEpoch: parsed.connectionEpoch,
              providerId: parsed.providerId || parsed.providerOrigin,
              providerInstanceId: parsed.providerInstanceId,
              providerConnectionId: parsed.providerConnectionId,
              providerTransport: parsed.providerTransport,
            };
          }
        }
      } catch {}
    }
    return null;
  }

  /**
   * Backend Real Partial Scale-Out at TP1 or TP2 (Creates Execution Leg ONLY — NO duplicate PaperTrade row)
   */
  private async executePartialScaleOut(
    pos: any,
    stageOrExitPrice: 'TP1' | 'TP2' | number,
    targetPriceOrTriggerPrice?: number,
    livePriceOrTriggerTime?: number | Date,
    marketEventTimeOrStage?: Date | 'TP1' | 'TP2',
    partialRatio = 0.3,
  ): Promise<{
    remainingQuantity: number;
    partialQty: number;
    newStopLoss: number;
    fillTimestamp: string;
    partialLegs: any[];
  } | null> {
    let stage: 'TP1' | 'TP2' = 'TP1';
    let targetPrice = 0;
    let livePrice = 0;
    let marketEventTime: Date = new Date();
    let ratio = partialRatio;

    if (typeof stageOrExitPrice === 'number') {
      livePrice = stageOrExitPrice;
      targetPrice = typeof targetPriceOrTriggerPrice === 'number' ? targetPriceOrTriggerPrice : livePrice;
      marketEventTime = livePriceOrTriggerTime instanceof Date ? livePriceOrTriggerTime : new Date();
      if (typeof marketEventTimeOrStage === 'string' && (marketEventTimeOrStage === 'TP1' || marketEventTimeOrStage === 'TP2')) {
        stage = marketEventTimeOrStage;
      }
      ratio = 0.3;
    } else {
      stage = stageOrExitPrice;
      targetPrice = typeof targetPriceOrTriggerPrice === 'number' ? targetPriceOrTriggerPrice : 0;
      livePrice = typeof livePriceOrTriggerTime === 'number' ? livePriceOrTriggerTime : targetPrice;
      marketEventTime = marketEventTimeOrStage instanceof Date ? marketEventTimeOrStage : new Date();
      ratio = partialRatio;
    }

    const idempotencyKey = stage === 'TP1' ? `tp1_partial:${pos.id}` : `tp2_partial:${pos.id}`;

    // Deterministic check to avoid duplicate execution
    let existingOrder: any = null;
    if (typeof (this.prisma.paperOrder as any).findFirst === 'function') {
      existingOrder = await this.prisma.paperOrder.findFirst({
        where: {
          OR: [
            { idempotencyKey },
            { idempotencyKey: `${stage.toLowerCase()}_partial_${pos.id}` },
          ],
        },
      });
    } else if (typeof (this.prisma.paperOrder as any).findUnique === 'function') {
      existingOrder = await this.prisma.paperOrder.findUnique({
        where: { idempotencyKey },
      });
    }
    if (existingOrder) {
      this.logger.log(
        `[${stage} IDEMPOTENCY] Scale-out already executed for position '${pos.id}'.`,
      );
      return null;
    }

    const existingEvents = (pos.executionEventsJson as any) || {};
    const partialLegs = existingEvents.partialLegs || [];
    const currentQuantity = Number(pos.quantity);
    const alreadyClosedQty = partialLegs.reduce(
      (sum: number, l: any) => sum + Number(l.quantity || 0),
      0,
    );
    const originalQuantity = Number(
      existingEvents.initialQuantity || (currentQuantity + alreadyClosedQty).toFixed(4),
    );
    const partialQty = Number((originalQuantity * ratio).toFixed(4));
    const remainingQty = Number((currentQuantity - partialQty).toFixed(4));
    const entryPrice = Number(pos.entryPrice);
    const isBuy = pos.direction === Direction.BULLISH;
    const isCrypto =
      pos.symbol === 'BTCUSDT' ||
      pos.symbol === 'BTCUSD' ||
      pos.symbol === 'BTCUSDT_SPOT';

    // Canonical P&L via TradeAccountingEngine using the persisted lifecycle accounting snapshot
    const openingSnapshot =
      existingEvents.accountingSnapshot ??
      (pos.featureSnapshotJson as any)?.accountingSnapshot;

    if (!openingSnapshot) {
      throw new Error(
        `[MALFORMED_LIFECYCLE] Cannot execute partial TP1 scale-out (stage: ${stage}) for position '${pos.id}': Missing authoritative immutable opening accounting snapshot. Silently querying an ad-hoc FX rate during execution leg settlement is strictly prohibited.`,
      );
    }
    const fxRate = openingSnapshot.fxRate;
    const contractSize = openingSnapshot.contractSize ?? 1;

    const exitTurnover = livePrice * partialQty * contractSize;
    const isGold = pos.symbol === 'XAUUSD' || pos.symbol === 'GOLD';
    const isOptionPos =
      pos.instrumentType === 'OPTION' ||
      Boolean(pos.strike) ||
      Boolean(pos.contractSymbol?.includes('CE') || pos.contractSymbol?.includes('PE'));
    const exitCharges = this.paperTradingService.calculateCharges(
      exitTurnover,
      isCrypto ? 'CRYPTO' : isGold ? 'COMMODITY' : isOptionPos ? 'OPTION' : 'EQUITY',
      fxRate,
      marketEventTime.getTime(),
      'EXIT',
      pos.contractSymbol || pos.symbol,
    );

    const initialSL = pos.initialStopLoss
      ? Number(pos.initialStopLoss)
      : pos.stopLoss
        ? Number(pos.stopLoss)
        : undefined;

    const legSettlement = TradeAccountingEngine.settleExecutionLeg({
      role: stage === 'TP1' ? 'TP1_PARTIAL' : 'TP2_PARTIAL',
      entryPrice,
      fillPrice: livePrice,
      quantity: partialQty,
      direction: isBuy ? Direction.BULLISH : Direction.BEARISH,
      accountingSnapshot: openingSnapshot,
      fxRate,
      fees: exitCharges.totalCharges,
      initialStopLoss: initialSL,
    });
    const partialGrossPnL = legSettlement.grossPnL;
    const partialNetPnL = legSettlement.netPnL;
    const partialRealizedR = legSettlement.realizedR;

    const posUsedMargin = Number(pos.usedMargin);
    const fractionOfCurrent = currentQuantity > 0 ? partialQty / currentQuantity : 0;
    const releasedMargin = Number((posUsedMargin * fractionOfCurrent).toFixed(2));

    const newStopLoss =
      stage === 'TP1' ? entryPrice : pos.target1 ? Number(pos.target1) : entryPrice;

    const execTimeStr = new Date().toISOString();
    const marketTimeStr = marketEventTime.toISOString();

    const newLeg = {
      role: stage === 'TP1' ? 'TP1_PARTIAL' : 'TP2_PARTIAL',
      quantity: partialQty,
      triggerPrice: targetPrice,
      triggerMarketEventTime: marketTimeStr,
      fillPrice: livePrice,
      fillTimestamp: execTimeStr,
      marketEventTime: marketTimeStr,
      observedAt: execTimeStr,
      receivedAt: execTimeStr,
      quotePrice: livePrice,
      quoteMarketEventTime: marketTimeStr,
      fee: exitCharges.totalCharges,
      feeBreakdown: exitCharges,
      grossPnL: partialGrossPnL,
      netPnL: partialNetPnL,
      realizedR: partialRealizedR,
      executionPriceSource: 'LIVE_TICK',
      slippage: 0,
      correlationId: pos.correlationId,
      price: livePrice,
      executionTime: execTimeStr,
      timestamp: marketTimeStr,
      fxRate,
      accountingSnapshotHash:
        legSettlement.accountingSnapshotHash ?? openingSnapshot?.snapshotHash,
    };

    const updatedPartialLegs = [...partialLegs, newLeg];

    const stageMetadata =
      stage === 'TP1'
        ? {
            tp1TriggeredAt: execTimeStr,
            tp1TriggerPrice: targetPrice,
            tp1TriggerMarketEventTime: marketTimeStr,
            tp1FillPrice: livePrice,
            tp1FillTime: execTimeStr,
            tp1Quantity: partialQty,
            tp1RealizedPnL: partialNetPnL,
            currentLifecycleState: TradeLifecycleState.TP1_PARTIAL_FILLED,
            currentStopLoss: newStopLoss,
            remainingQuantity: remainingQty,
            highestTargetReached: 'TP1',
          }
        : {
            tp2TriggeredAt: execTimeStr,
            tp2TriggerPrice: targetPrice,
            tp2TriggerMarketEventTime: marketTimeStr,
            tp2FillPrice: livePrice,
            tp2FillTime: execTimeStr,
            tp2Quantity: partialQty,
            tp2RealizedPnL: partialNetPnL,
            currentLifecycleState: TradeLifecycleState.TP2_PARTIAL_FILLED,
            currentStopLoss: newStopLoss,
            remainingQuantity: remainingQty,
            highestTargetReached: 'TP2',
          };

    try {
      await this.prisma.$transaction(async (tx) => {
        let existingTxOrder: any = null;
        if (typeof (tx.paperOrder as any).findFirst === 'function') {
          existingTxOrder = await (tx.paperOrder as any).findFirst({
            where: {
              OR: [
                { idempotencyKey },
                { idempotencyKey: `${stage.toLowerCase()}_partial_${pos.id}` },
              ],
            },
          });
        } else if (typeof (tx.paperOrder as any).findUnique === 'function') {
          existingTxOrder = await (tx.paperOrder as any).findUnique({
            where: { idempotencyKey },
          });
        }
        if (existingTxOrder) return;

        const updated = await tx.paperPosition.updateMany({
          where:
            stage === 'TP1'
              ? { id: pos.id, status: PositionState.OPEN }
              : { id: pos.id, status: PositionState.PARTIALLY_CLOSED },
          data: {
            status: PositionState.PARTIALLY_CLOSED,
            quantity: new Decimal(remainingQty),
            stopLoss: new Decimal(newStopLoss),
            usedMargin: new Decimal(Math.max(0, posUsedMargin - releasedMargin)),
            executionEventsJson: {
              ...existingEvents,
              initialQuantity: originalQuantity,
              accountingSnapshot: openingSnapshot ?? existingEvents.accountingSnapshot,
              accountingSnapshotHash:
                openingSnapshot?.snapshotHash ?? existingEvents.accountingSnapshotHash,
              ...stageMetadata,
              partialLegs: updatedPartialLegs,
            } as any,
          },
        });

        if (updated.count === 0) return;

        const exitOrder = await tx.paperOrder.create({
          data: {
            accountId: pos.accountId,
            tradeDecisionId: pos.tradeDecisionId || null,
            executionId: pos.executionId || null,
            symbol: pos.symbol,
            contractSymbol: pos.contractSymbol,
            instrumentType: pos.instrumentType,
            direction: isBuy ? Direction.BEARISH : Direction.BULLISH,
            orderType: 'MARKET',
            requestedQuantity: new Decimal(partialQty),
            filledQuantity: new Decimal(partialQty),
            price: new Decimal(livePrice),
            status: 'FILLED',
            idempotencyKey,
            correlationId: pos.correlationId,
            submittedAt: new Date(),
            orderSubmittedAt: new Date(),
            firstFillAt: new Date(),
          },
        });

        await tx.paperFill.create({
          data: {
            orderId: exitOrder.id,
            positionId: pos.id,
            executionRole: stage === 'TP1' ? 'TP1_PARTIAL' : 'TP2_PARTIAL',
            fillPrice: new Decimal(livePrice),
            fillQuantity: new Decimal(partialQty),
            fee: new Decimal(exitCharges.totalCharges),
            feeBreakdownJson: exitCharges as any,
            slippage: new Decimal(0),
            executionPriceSource: 'LIVE_TICK',
            liquidityType: 'TAKER',
            sourceTimestamp: marketEventTime,
            fillTimestamp: new Date(),
            correlationId: pos.correlationId,
          },
        });

        // Update PaperAccount
        await tx.paperAccount.update({
          where: { id: pos.accountId },
          data: {
            cashBalance: { increment: new Decimal(legSettlement.cashDelta) },
            usedMargin: { decrement: new Decimal(releasedMargin) },
            realizedPnL: { increment: new Decimal(legSettlement.realizedPnLDelta) },
            totalChargesPaid: { increment: new Decimal(exitCharges.totalCharges) },
          },
        });

        // Synchronize TradeDecision if linked
        const tradeDecisionId = existingEvents.tradeDecisionId || pos.tradeDecisionId;
        if (tradeDecisionId) {
          await tx.tradeDecision.updateMany({
            where: { id: tradeDecisionId },
            data: {
              lifecycleState: stageMetadata.currentLifecycleState,
              updatedAt: new Date(),
            },
          });
        }

        // Emit Stage Audit Events
        if (stage === 'TP1') {
          await tx.auditEvent.create({
            data: {
              actor: 'SYSTEM',
              service: 'PAPER_TRADING',
              eventType: 'TP1_TRIGGERED',
              entityType: 'POSITION',
              entityId: pos.id,
              payloadJson: { targetPrice, livePrice, partialQty, positionId: pos.id },
              correlationId: pos.correlationId,
            },
          });
          await tx.auditEvent.create({
            data: {
              actor: 'SYSTEM',
              service: 'PAPER_TRADING',
              eventType: 'TP1_FILLED',
              entityType: 'ORDER',
              entityId: exitOrder.id,
              payloadJson: {
                orderId: exitOrder.id,
                fillPrice: livePrice,
                quantity: partialQty,
                netPnL: partialNetPnL,
              },
              correlationId: pos.correlationId,
            },
          });
          await tx.auditEvent.create({
            data: {
              actor: 'SYSTEM',
              service: 'PAPER_TRADING',
              eventType: 'POSITION_PARTIALLY_CLOSED',
              entityType: 'POSITION',
              entityId: pos.id,
              payloadJson: { positionId: pos.id, remainingQuantity: remainingQty, stage: 'TP1' },
              correlationId: pos.correlationId,
            },
          });
          await tx.auditEvent.create({
            data: {
              actor: 'SYSTEM',
              service: 'PAPER_TRADING',
              eventType: 'STOP_MOVED_TO_BREAKEVEN',
              entityType: 'POSITION',
              entityId: pos.id,
              payloadJson: { positionId: pos.id, newStopLoss },
              correlationId: pos.correlationId,
            },
          });
        } else {
          await tx.auditEvent.create({
            data: {
              actor: 'SYSTEM',
              service: 'PAPER_TRADING',
              eventType: 'TP2_TRIGGERED',
              entityType: 'POSITION',
              entityId: pos.id,
              payloadJson: { targetPrice, livePrice, partialQty, positionId: pos.id },
              correlationId: pos.correlationId,
            },
          });
          await tx.auditEvent.create({
            data: {
              actor: 'SYSTEM',
              service: 'PAPER_TRADING',
              eventType: 'TP2_FILLED',
              entityType: 'ORDER',
              entityId: exitOrder.id,
              payloadJson: {
                orderId: exitOrder.id,
                fillPrice: livePrice,
                quantity: partialQty,
                netPnL: partialNetPnL,
              },
              correlationId: pos.correlationId,
            },
          });
        }
      });
    } catch (err: any) {
      if (
        err?.code === 'P2002' ||
        err?.message?.includes('P2002') ||
        err?.message?.includes('idempotencyKey')
      ) {
        this.logger.log(
          `[${stage} IDEMPOTENCY P2002] Concurrent race caught for position '${pos.id}'. Order idempotently created by another process.`,
        );
        return null;
      }
      throw err;
    }

    this.logger.log(
      `✓ [${stage} PARTIAL SCALE-OUT EXECUTED] Position '${pos.id}' reduced from ${currentQuantity} to ${remainingQty}. SL: ${newStopLoss}. Realized P&L: ₹${partialNetPnL}. Execution leg created.`,
    );

    return {
      remainingQuantity: remainingQty,
      partialQty,
      newStopLoss,
      fillTimestamp: execTimeStr,
      partialLegs: updatedPartialLegs,
    };
  }

  private async publishTradeClosedEvent(trade: any) {
    if (this.redis) {
      try {
        const redisClient = this.redis.getClient();
        if (redisClient && redisClient.status === 'ready') {
          const payload = {
            tradeId: trade.id,
            positionId: trade.positionId,
            symbol: trade.symbol,
            direction: trade.direction,
            exitPrice: trade.exitPrice,
            realizedPnL: trade.realizedPnL,
            realizedR: trade.realizedR,
            exitReason: trade.exitReason,
            closedAt: trade.closedAt,
          };
          await redisClient.publish(WS_EVENTS.PAPER_POSITION_CLOSED, JSON.stringify(payload));
          await redisClient.publish(WS_EVENTS.SIGNAL_CLOSED, JSON.stringify(payload));
        }
      } catch (err: any) {
        this.logger.warn(`Failed to publish WS trade closed event: ${err.message}`);
      }
    }
  }
}
