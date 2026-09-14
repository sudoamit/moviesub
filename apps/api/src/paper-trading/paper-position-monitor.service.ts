import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PaperTradingService } from './paper-trading.service';
import { ExecutionMode } from './execution-provider.interface';
import { RealMarketStreamerService, QuoteProvenance, ILiveRealTicker } from '../market-data/real-market-streamer.service';
import { RedisService } from '../common/redis/redis.service';
import { Direction, PositionState, WS_EVENTS } from '@quant/shared';
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
        if (!optionQuote || optionQuote.provenance !== 'LIVE_PROVIDER' || optionQuote.price <= 0) {
          // If exact option LTP is unavailable, do NOT fall back to spot price. Fail closed.
          return;
        }
        livePrice = optionQuote.price;
        marketEventTime = new Date(optionQuote.marketEventTime || optionQuote.lastUpdated);
        provenance = optionQuote.provenance;
      } else {
        // Spot or Crypto: fetch validated ticker
        const ticker = this.realMarketStreamer.getValidatedTicker(symbol, 5);
        if (!ticker || ticker.provenance !== 'LIVE_PROVIDER' || ticker.price <= 0) {
          return;
        }
        livePrice = ticker.price;
        marketEventTime = new Date(ticker.marketEventTime || ticker.lastUpdated);
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
          if (parsed.price > 0 && Date.now() - parsed.timestamp <= 5000) {
            return {
              symbol: pos.contractSymbol,
              price: parsed.price,
              open: parsed.price,
              high: parsed.price,
              low: parsed.price,
              close: parsed.price,
              volume: 1000,
              prevClose: parsed.price,
              changePercent: 0,
              changeAmount: 0,
              tickSize: 0.05,
              volatility: 1.0,
              lastUpdated: parsed.timestamp,
              provenance: 'LIVE_PROVIDER',
              marketEventTime: parsed.marketEventTime || parsed.timestamp,
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
  ) {
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
    const partialRatio = 0.5;
    const partialQty = totalQuantity * partialRatio;
    const remainingQty = totalQuantity - partialQty;
    const entryPrice = Number(pos.entryPrice);
    const isBuy = pos.direction === Direction.BULLISH;
    const isCrypto = pos.symbol === 'BTCUSDT' || pos.symbol === 'BTCUSD';

    const exitTurnover = livePrice * partialQty;
    const exitCharges = this.paperTradingService.calculateCharges(exitTurnover, isCrypto);

    const priceDiff = isBuy ? livePrice - entryPrice : entryPrice - livePrice;
    const USDT_INR_RATE = isCrypto ? 92.0 : 1.0;
    const priceDiffINR = priceDiff * USDT_INR_RATE;
    const partialGrossPnL = priceDiffINR * partialQty;
    const partialNetPnL = Number((partialGrossPnL - exitCharges.totalCharges).toFixed(2));

    const initialSL = pos.initialStopLoss ? Number(pos.initialStopLoss) : (pos.stopLoss ? Number(pos.stopLoss) : entryPrice);
    const riskDistance = initialSL ? Math.abs(entryPrice - initialSL) : 0;
    const partialRealizedR = riskDistance > 0 ? Number((priceDiff / riskDistance).toFixed(2)) : 0;
    const releasedMargin = Number((Number(pos.usedMargin) * partialRatio).toFixed(2));

    const existingEvents = (pos.executionEventsJson as any) || {};
    const partialLegs = existingEvents.partialLegs || [];
    partialLegs.push({
      role: 'TP1_PARTIAL',
      price: livePrice,
      quantity: partialQty,
      fee: exitCharges.totalCharges,
      grossPnL: partialGrossPnL,
      netPnL: partialNetPnL,
      realizedR: partialRealizedR,
      timestamp: marketEventTime.toISOString(),
    });

    await this.prisma.$transaction(async (tx) => {
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

      // Update PaperAccount balance and used margin ONLY — PaperTrade record is created ONLY on final exit
      await tx.paperAccount.update({
        where: { id: pos.accountId },
        data: {
          cashBalance: { increment: new Decimal(partialNetPnL) },
          usedMargin: { decrement: new Decimal(releasedMargin) },
          realizedPnL: { increment: new Decimal(partialNetPnL) },
          totalChargesPaid: { increment: new Decimal(exitCharges.totalCharges) },
        },
      });
    });

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
