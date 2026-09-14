import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PaperTradingService } from './paper-trading.service';
import { ExecutionMode } from './execution-provider.interface';
import { RealMarketStreamerService, QuoteProvenance, ILiveRealTicker } from '../market-data/real-market-streamer.service';
import { RedisService } from '../common/redis/redis.service';
import { Direction, PositionState, WS_EVENTS, getAuthoritativeInstrument, PointInTimeCurrencyConverter } from '@quant/shared';
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
        if (!optionQuote || optionQuote.provenance !== 'LIVE_PROVIDER' || optionQuote.price <= 0 || !optionQuote.marketEventTime || optionQuote.marketEventTime <= 0) {
          // If exact option LTP is unavailable or missing marketEventTime, do NOT fall back. Fail closed.
          return;
        }
        livePrice = optionQuote.price;
        marketEventTime = new Date(optionQuote.marketEventTime);
        provenance = optionQuote.provenance;
      } else {
        // Spot or Crypto: fetch validated ticker
        const ticker = this.realMarketStreamer.getValidatedTicker(symbol, 5);
        if (!ticker || ticker.provenance !== 'LIVE_PROVIDER' || ticker.price <= 0 || !ticker.marketEventTime || ticker.marketEventTime <= 0) {
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

    const entryPrice = Number(pos.entryPrice);
    const stopLoss = pos.stopLoss ? Number(pos.stopLoss) : null;
    const target1 = pos.target1 ? Number(pos.target1) : null;
    const target2 = pos.target2 ? Number(pos.target2) : null;
    const target3 = pos.target3 ? Number(pos.target3) : null;

    // 2. Evaluate Active Stop Loss Threshold
    let isSLHit = false;
    if (stopLoss !== null) {
      if (isBuy && livePrice <= stopLoss) {
        isSLHit = true;
      } else if (!isBuy && livePrice >= stopLoss) {
        isSLHit = true;
      }
    }

    if (isSLHit) {
      this.logger.log(
        `🚨 [AUTO TP/SL MONITOR] SL Threshold Crossed for position '${pos.id}' (${pos.contractSymbol}): Live ${livePrice} vs SL ${stopLoss}. Triggering backend auto-close...`,
      );
      try {
        const completedTrade = await this.paperTradingService.closePosition(
          pos.id,
          'Stop Loss Hit',
          {
            triggerPrice: stopLoss!,
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

    // 3. Evaluate Target 2 / Target 3 Full Take-Profit Thresholds
    const activeFullTarget = target3 ?? target2;
    let isTPHit = false;
    if (activeFullTarget !== null) {
      if (isBuy && livePrice >= activeFullTarget) {
        isTPHit = true;
      } else if (!isBuy && livePrice <= activeFullTarget) {
        isTPHit = true;
      }
    }

    if (isTPHit) {
      const exitReason = target3 && livePrice >= target3 ? 'Target 3 Completed' : 'Target 2 Completed';
      this.logger.log(
        `🎯 [AUTO TP/SL MONITOR] TP Threshold Crossed for position '${pos.id}' (${pos.contractSymbol}): Live ${livePrice} vs Target ${activeFullTarget}. Triggering backend auto-close...`,
      );
      try {
        const completedTrade = await this.paperTradingService.closePosition(
          pos.id,
          exitReason,
          {
            triggerPrice: activeFullTarget!,
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
        this.logger.error(`Failed auto-closing position '${pos.id}' on TP: ${err.message}`);
        return;
      }
    }

    // 4. Evaluate TP1 Partial Scale-Out (if position is OPEN and has target1)
    if (target1 !== null && pos.status === PositionState.OPEN) {
      let isTP1Hit = false;
      if (isBuy && livePrice >= target1) {
        isTP1Hit = true;
      } else if (!isBuy && livePrice <= target1) {
        isTP1Hit = true;
      }

      if (isTP1Hit) {
        this.logger.log(
          `✂️ [AUTO TP/SL MONITOR] TP1 Scale-Out Crossed for position '${pos.id}' (${pos.contractSymbol}): Live ${livePrice} vs Target1 ${target1}. Executing 50% partial close...`,
        );
        try {
          await this.executePartialScaleOut(pos, target1, livePrice, marketEventTime);
        } catch (err: any) {
          this.logger.error(`Failed partial scale-out for position '${pos.id}': ${err.message}`);
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
          const parsed = JSON.parse(cached);
          const rawEventTime = parsed.marketEventTime;
          const eventTime = rawEventTime ? Number(rawEventTime) : undefined;
          const currentEpoch = this.realMarketStreamer?.getConnectionEpoch();

          // Strict provenance authority:
          // A Redis cached quote is ONLY permitted to declare LIVE_PROVIDER if:
          // 1. The Redis entry itself explicitly carries authenticated provider-origin metadata
          // 2. The entry has a genuine, positive marketEventTime within 5s freshness
          // 3. The entry preserves connectionEpoch matching the current active streamer connection epoch
          // 4. The streamer provider is currently connected and healthy
          const isStreamerConnected = this.realMarketStreamer?.getProviderState() !== 'DISCONNECTED';
          const isFresh = eventTime !== undefined && Number.isFinite(eventTime) && Date.now() - eventTime <= 5000;
          const hasProviderOrigin = Boolean(parsed.providerId || parsed.providerOrigin);
          const isEpochMatching = parsed.connectionEpoch !== undefined && parsed.connectionEpoch === currentEpoch;
          const isAuthenticProvider =
            isStreamerConnected &&
            parsed.provenance === 'LIVE_PROVIDER' &&
            hasProviderOrigin &&
            isFresh &&
            isEpochMatching;

          const provenance: QuoteProvenance = isAuthenticProvider ? 'LIVE_PROVIDER' : 'DEGRADED';

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
              tickSize: (getAuthoritativeInstrument(pos.symbol)?.tickSize ?? undefined),
              volatility: parsed.volatility,
              lastUpdated: parsed.timestamp || Date.now(),
              provenance,
              marketEventTime: eventTime,
              connectionEpoch: parsed.connectionEpoch,
              providerId: parsed.providerId || parsed.providerOrigin,
            };
          }
        }
      } catch {}
    }
    return null;
  }

  /**
   * Backend Real Partial Scale-Out at TP1 (Creates Execution Leg ONLY — NO duplicate PaperTrade row)
   */
  private async executePartialScaleOut(
    pos: any,
    target1: number,
    livePrice: number,
    marketEventTime: Date,
    partialRatio = 0.5,
  ): Promise<void> {
    const idempotencyKey = `tp1_partial_${pos.id}`;

    // Deterministic check to avoid duplicate TP1 execution
    const existingOrder = await this.prisma.paperOrder.findUnique({
      where: { idempotencyKey },
    });
    if (existingOrder) {
      this.logger.log(`[TP1 IDEMPOTENCY] Partial scale-out already executed for position '${pos.id}'.`);
      return;
    }

    const totalQuantity = Number(pos.quantity);
    const partialQty = Number((totalQuantity * partialRatio).toFixed(4));
    const remainingQty = totalQuantity - partialQty;
    const entryPrice = Number(pos.entryPrice);
    const isBuy = pos.direction === Direction.BULLISH;
    const isCrypto = pos.symbol === 'BTCUSDT' || pos.symbol === 'BTCUSD';

    const exitTurnover = livePrice * partialQty;
    const exitCharges = this.paperTradingService.calculateCharges(exitTurnover, isCrypto);

    // Canonical P&L via TradeAccountingEngine using the persisted lifecycle accounting snapshot
    const openingSnapshot =
      (pos.executionEventsJson as any)?.accountingSnapshot ??
      (pos.featureSnapshotJson as any)?.accountingSnapshot;

    if (!openingSnapshot) {
      throw new Error(
        `[MALFORMED_LIFECYCLE] Cannot execute partial TP1 scale-out for position '${pos.id}': Missing authoritative immutable opening accounting snapshot. Silently querying an ad-hoc FX rate during execution leg settlement is strictly prohibited.`,
      );
    }
    const fxRate = openingSnapshot.fxRate;

    const initialSL = pos.initialStopLoss ? Number(pos.initialStopLoss) : (pos.stopLoss ? Number(pos.stopLoss) : undefined);

    const legSettlement = TradeAccountingEngine.settleExecutionLeg({
      role: 'TP1_PARTIAL',
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
    const releasedMargin = Number((Number(pos.usedMargin) * partialRatio).toFixed(2));

    const existingEvents = (pos.executionEventsJson as any) || {};
    const partialLegs = existingEvents.partialLegs || [];
    const execTimeStr = new Date().toISOString();
    const marketTimeStr = marketEventTime.toISOString();
    partialLegs.push({
      role: 'TP1_PARTIAL',
      quantity: partialQty,
      triggerPrice: target1,
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
      accountingSnapshotHash: legSettlement.accountingSnapshotHash ?? openingSnapshot?.snapshotHash,
    });

    try {
      await this.prisma.$transaction(async (tx) => {
        const existingTxOrder = await tx.paperOrder.findUnique({
          where: { idempotencyKey },
        });
        if (existingTxOrder) return;

        const updated = await tx.paperPosition.updateMany({
          where: {
            id: pos.id,
            status: { in: [PositionState.OPEN] },
          },
          data: {
            status: PositionState.PARTIALLY_CLOSED,
            quantity: new Decimal(remainingQty),
            stopLoss: new Decimal(entryPrice), // Move SL to breakeven
            usedMargin: new Decimal(Number(pos.usedMargin) - releasedMargin),
            executionEventsJson: {
              ...existingEvents,
              accountingSnapshot: openingSnapshot ?? existingEvents.accountingSnapshot,
              accountingSnapshotHash: openingSnapshot?.snapshotHash ?? existingEvents.accountingSnapshotHash,
              partialLegs,
            } as any,
          },
        });

        if (updated.count === 0) return;

        const exitOrder = await tx.paperOrder.create({
          data: {
            accountId: pos.accountId,
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
          },
        });

        await tx.paperFill.create({
          data: {
            orderId: exitOrder.id,
            fillPrice: new Decimal(livePrice),
            fillQuantity: new Decimal(partialQty),
            fee: new Decimal(exitCharges.totalCharges),
            feeBreakdownJson: exitCharges,
            slippage: new Decimal(0),
            executionPriceSource: 'LIVE_TICK',
            liquidityType: 'TAKER',
            sourceTimestamp: marketEventTime,
            fillTimestamp: new Date(),
            correlationId: pos.correlationId,
          },
        });

        // MODEL-A ACCOUNTING CONTRACT:
        // At TP1 partial exit: cashBalance += TP1 grossPnL - TP1 exitFees, realizedPnL += TP1 grossPnL - TP1 exitFees, totalChargesPaid += TP1 exitFees, usedMargin -= releasedMargin.
        // PaperTrade record is created ONLY on final exit to preserve 1 Position = 1 PaperTrade lifecycle.
        await tx.paperAccount.update({
          where: { id: pos.accountId },
          data: {
            cashBalance: { increment: new Decimal(legSettlement.cashDelta) },
            usedMargin: { decrement: new Decimal(releasedMargin) },
            realizedPnL: { increment: new Decimal(legSettlement.realizedPnLDelta) },
            totalChargesPaid: { increment: new Decimal(exitCharges.totalCharges) },
          },
        });
      });
    } catch (err: any) {
      if (err?.code === 'P2002' || err?.message?.includes('P2002') || err?.message?.includes('idempotencyKey')) {
        this.logger.log(
          `[TP1 IDEMPOTENCY P2002] Concurrent race caught for position '${pos.id}'. Order idempotently created by another process.`,
        );
        return;
      }
      throw err;
    }

    this.logger.log(
      `✓ [TP1 PARTIAL SCALE-OUT EXECUTED] Position '${pos.id}' reduced from ${totalQuantity} to ${remainingQty}. SL moved to breakeven (${entryPrice}). Realized P&L: ₹${partialNetPnL}. Execution leg created.`,
    );
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
