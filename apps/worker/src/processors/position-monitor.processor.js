"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var PositionMonitorProcessor_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PositionMonitorProcessor = void 0;
const bullmq_1 = require("@nestjs/bullmq");
const common_1 = require("@nestjs/common");
const shared_1 = require("@quant/shared");
const prisma_service_1 = require("../prisma.service");
const redis_service_1 = require("../redis.service");
const trading_engine_1 = require("@quant/trading-engine");
const library_1 = require("@prisma/client/runtime/library");
let PositionMonitorProcessor = PositionMonitorProcessor_1 = class PositionMonitorProcessor extends bullmq_1.WorkerHost {
    prisma;
    redis;
    logger = new common_1.Logger(PositionMonitorProcessor_1.name);
    constructor(prisma, redis) {
        super();
        this.prisma = prisma;
        this.redis = redis;
    }
    async process(job) {
        this.logger.debug(`[PositionMonitor] Evaluating active positions for job ${job.id}`);
        return this.evaluateActivePositions();
    }
    /**
     * Retrieves persisted trading system configuration.
     */
    async getSystemConfig() {
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
                        maxDailyLossPercent: new library_1.Decimal(3.0),
                        maxPositionRiskPercent: new library_1.Decimal(1.0),
                        maxTotalExposurePercent: new library_1.Decimal(20.0),
                        maxOpenPositions: 5,
                        maxTradesPerDay: 20,
                        maxConsecutiveLosses: 3,
                        maxLeverage: new library_1.Decimal(5.0),
                        maxSlippageBps: 50,
                        maxMarketDataAgeSeconds: 5,
                    },
                });
            }
            if (config &&
                typeof config.maxMarketDataAgeSeconds === 'number' &&
                typeof config.maxSlippageBps === 'number') {
                return {
                    maxMarketDataAgeSeconds: config.maxMarketDataAgeSeconds,
                    maxSlippageBps: config.maxSlippageBps,
                };
            }
            return null;
        }
        catch (err) {
            this.logger.error(`[PositionMonitor] Failed to load TradingSystemConfig: ${err?.message}`);
            return null;
        }
    }
    /**
     * Main evaluation loop for all open/partially closed positions across all paper accounts.
     */
    async evaluateActivePositions() {
        const config = await this.getSystemConfig();
        if (!config ||
            typeof config.maxMarketDataAgeSeconds !== 'number' ||
            typeof config.maxSlippageBps !== 'number') {
            this.logger.error('[PositionMonitor] Failed to load TradingSystemConfig from database. Failing closed.');
            return { checked: 0, closed: 0, updated: 0 };
        }
        const maxMarketDataAgeSeconds = config.maxMarketDataAgeSeconds;
        const maxSlippageBps = config.maxSlippageBps;
        const activePositions = await this.prisma.paperPosition.findMany({
            where: {
                status: { in: [shared_1.PositionState.OPEN, shared_1.PositionState.PARTIALLY_CLOSED, shared_1.PositionState.EXIT_PENDING] },
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
                    if (pos.status === shared_1.PositionState.EXIT_PENDING) {
                        this.logger.debug(`[PositionMonitor] Position ${pos.id} (${pos.symbol}) is EXIT_PENDING but waiting for a fresh live tick; remaining EXIT_PENDING.`);
                    }
                    continue;
                }
                const livePrice = liveTick.price;
                const tickTimestamp = liveTick.timestamp;
                // If position was already EXIT_PENDING, attempt immediate close ONLY with the validated fresh live tick
                if (pos.status === shared_1.PositionState.EXIT_PENDING) {
                    await this.executeFullClose(pos, livePrice, 'Exit Pending Completed on Next Tick', 'MANUAL', tickTimestamp, maxSlippageBps);
                    closedCount++;
                    continue;
                }
                const isClosed = await this.evaluatePositionTick(pos, livePrice, tickTimestamp, maxSlippageBps);
                if (isClosed) {
                    closedCount++;
                }
                else {
                    updatedCount++;
                }
            }
            catch (err) {
                this.logger.error(`Error evaluating position ${pos.id} (${pos.symbol}): ${err?.message}`);
            }
        }
        return { checked: activePositions.length, closed: closedCount, updated: updatedCount };
    }
    /**
     * Resolves execution/monitoring price exclusively from the live ticker cache: ticker:${SYMBOL}:live
     * NEVER queries PostgreSQL candles or candle caches.
     */
    async resolveLivePrice(symbol, maxAgeSeconds) {
        const sym = symbol.toUpperCase();
        try {
            const cached = await this.redis.get(`ticker:${sym}:live`);
            if (!cached) {
                this.logger.debug(`[PositionMonitor] No live ticker cached under 'ticker:${sym}:live' for ${sym}; skipping evaluation`);
                return null;
            }
            const validated = shared_1.ExecutionPriceResolver.validateLiveTicker(cached, maxAgeSeconds);
            if (validated && validated.price > 0) {
                return validated;
            }
            this.logger.warn(`[PositionMonitor] Live tick for ${sym} is stale (> ${maxAgeSeconds}s) or invalid; skipping execution to fail closed`);
            return null;
        }
        catch (err) {
            this.logger.error(`[PositionMonitor] Error resolving live tick for ${sym}: ${err?.message}`);
            return null;
        }
    }
    calculateCharges(turnover, isCrypto) {
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
        const totalCharges = Number((brokerage + stt + exchangeTurnover + gst + sebiTurnover).toFixed(2));
        return { brokerage, stt, exchangeTurnover, gst, sebiTurnover, totalCharges };
    }
    async evaluatePositionTick(pos, livePrice, tickTimestamp, maxSlippageBps = 50) {
        const entryPrice = Number(pos.entryPrice);
        const quantity = Number(pos.quantity);
        const isBuy = pos.direction === shared_1.Direction.BULLISH;
        const priceDiff = isBuy ? livePrice - entryPrice : entryPrice - livePrice;
        // Use ONLY persisted position values (never invent synthetic risk levels)
        const stopLoss = pos.stopLoss ? Number(pos.stopLoss) : undefined;
        const initialStopLoss = pos.initialStopLoss ? Number(pos.initialStopLoss) : stopLoss;
        const riskAnchor = initialStopLoss ?? stopLoss;
        // If no risk anchor exists, riskDistance is 0 and currentR is 0 (no synthetic fallback)
        const riskDistance = riskAnchor ? Math.abs(entryPrice - riskAnchor) : 0;
        const currentR = riskDistance > 0 ? Number((priceDiff / riskDistance).toFixed(2)) : 0;
        if (!riskAnchor) {
            this.logger.warn(`[PositionMonitor] Position ${pos.id} (${pos.symbol}) is missing persisted StopLoss; SL evaluation skipped without fabricating risk levels.`);
        }
        // Track MAE / MFE
        const currentMFE = Math.max(Number(pos.maxFavorableExcursion || 0), priceDiff > 0 ? priceDiff : 0);
        const currentMAE = Math.max(Number(pos.maxAdverseExcursion || 0), priceDiff < 0 ? Math.abs(priceDiff) : 0);
        const posAgeMs = Date.now() - new Date(pos.openedAt).getTime();
        const minAgeMs = 3000; // Minimum 3s to prevent race condition exits
        // Trailing stop evaluation: ONLY if all required persisted values exist (entry, initial SL, TP1, TP2)
        let newStopLoss = pos.stopLoss ? Number(pos.stopLoss) : undefined;
        let trailingStateJson = undefined;
        if (initialStopLoss &&
            pos.initialTarget1 &&
            pos.initialTarget2 &&
            Number(pos.initialTarget1) > 0 &&
            Number(pos.initialTarget2) > 0 &&
            entryPrice > 0) {
            const trailing = trading_engine_1.TrailingEngine.evaluate(entryPrice, Number(initialStopLoss), Number(pos.initialTarget1), Number(pos.initialTarget2), livePrice, isBuy ? 'BULLISH' : 'BEARISH');
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
                }
                else if (!isBuy && trailing.currentStopLoss < (newStopLoss || Infinity)) {
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
            await this.executeFullClose(pos, livePrice, exitReason, outcomeClassification, tickTimestamp, maxSlippageBps);
            return true;
        }
        // Update ongoing unrealized P&L, MFE/MAE, and trailing stop in PostgreSQL
        const entryCharges = pos.chargesJson || { totalCharges: 0 };
        const unrealizedPnL = Number((priceDiff * quantity - entryCharges.totalCharges).toFixed(2));
        await this.prisma.paperPosition.update({
            where: { id: pos.id },
            data: {
                currentPrice: new library_1.Decimal(livePrice),
                stopLoss: newStopLoss ? new library_1.Decimal(newStopLoss) : undefined,
                unrealizedPnL: new library_1.Decimal(unrealizedPnL),
                unrealizedR: new library_1.Decimal(currentR),
                maxFavorableExcursion: new library_1.Decimal(currentMFE),
                maxAdverseExcursion: new library_1.Decimal(currentMAE),
                trailingStopStateJson: trailingStateJson,
            },
        });
        return false;
    }
    async executeFullClose(pos, exitPrice, exitReason, outcomeClassification, sourceTimestamp, maxSlippageBps = 50) {
        // Apply exit slippage simulation within configured maxSlippageBps
        const isBuy = pos.direction === shared_1.Direction.BULLISH;
        const slip = shared_1.ExecutionPriceResolver.calculateSlippage(exitPrice, isBuy ? 'SELL' : 'BUY', maxSlippageBps);
        const finalExitPrice = slip.fillPrice;
        const exitTime = new Date();
        const tickSourceTime = sourceTimestamp || exitTime;
        const isCrypto = pos.symbol === 'BTCUSDT';
        const quantity = Number(pos.quantity);
        const entryPrice = Number(pos.entryPrice);
        const exitTurnover = finalExitPrice * quantity;
        const exitCharges = this.calculateCharges(exitTurnover, isCrypto);
        const entryCharges = pos.chargesJson || { totalCharges: 0 };
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
        const holdingDurationSeconds = Math.max(0, Math.floor((exitTime.getTime() - new Date(pos.openedAt).getTime()) / 1000));
        let closedSuccessfully = false;
        await this.prisma.$transaction(async (tx) => {
            // 1. Atomic state transition: OPEN/EXIT_PENDING/PARTIALLY_CLOSED -> CLOSING (Double-Close Guard)
            const lockResult = await tx.paperPosition.updateMany({
                where: {
                    id: pos.id,
                    status: { in: [shared_1.PositionState.OPEN, shared_1.PositionState.PARTIALLY_CLOSED, shared_1.PositionState.EXIT_PENDING] },
                },
                data: {
                    status: shared_1.PositionState.CLOSING,
                },
            });
            if (lockResult.count === 0) {
                // Concurrency check: another worker/thread already closed this position!
                const existingTrade = await tx.paperTrade.findFirst({
                    where: { positionId: pos.id },
                    orderBy: { exitTime: 'desc' },
                });
                if (existingTrade) {
                    this.logger.debug(`[PositionMonitor] Position ${pos.id} is already closed (trade: ${existingTrade.id}); idempotent close recognized.`);
                    return;
                }
                this.logger.warn(`[PositionMonitor] Position ${pos.id} is already CLOSING or CLOSED by another thread/worker; skipping duplicate close.`);
                return;
            }
            // 2. Mark position CLOSED
            await tx.paperPosition.update({
                where: { id: pos.id },
                data: {
                    status: shared_1.PositionState.CLOSED,
                    closedAt: exitTime,
                    currentPrice: new library_1.Decimal(finalExitPrice),
                    unrealizedPnL: new library_1.Decimal(0.0),
                    unrealizedR: new library_1.Decimal(0.0),
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
                    exitPrice: new library_1.Decimal(finalExitPrice),
                    realizedPnL: new library_1.Decimal(realizedPnL),
                    realizedR: new library_1.Decimal(realizedR),
                    maxFavorableExcursion: pos.maxFavorableExcursion,
                    maxAdverseExcursion: pos.maxAdverseExcursion,
                    holdingDurationSeconds,
                    entryTime: pos.entryTime,
                    exitTime,
                    exitReason,
                    chargesJson: { entryCharges, exitCharges, totalCharges },
                    featureSnapshotJson: pos.featureSnapshotJson || undefined,
                    outcomeSnapshotJson: {
                        executionPriceSource: shared_1.ExecutionPriceSource.LIVE_TICK,
                        sourceTimestamp: tickSourceTime.toISOString(),
                        livePrice: exitPrice,
                        exitPrice: finalExitPrice,
                        slippageBps: slip.slippageBps,
                        slippageAmount: slip.slippageAmount,
                        exitReason,
                        realizedPnL,
                        realizedR,
                        holdingDurationSeconds,
                        outcomeClassification,
                        exitTime: exitTime.toISOString(),
                        correlationId: pos.correlationId || `corr_${Date.now()}`,
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
                        executionPriceSource: shared_1.ExecutionPriceSource.LIVE_TICK,
                        sourceTimestamp: tickSourceTime.toISOString(),
                        slippageBps: slip.slippageBps,
                        slippageAmount: slip.slippageAmount,
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
        this.logger.log(`✓ [POSITION MONITOR CLOSED] ${pos.contractSymbol} @ ₹${finalExitPrice.toFixed(2)} | Net PnL: ₹${realizedPnL.toFixed(2)} (${realizedR}R) [${exitReason}]`);
        // Publish WebSocket notification
        const redisClient = this.redis.getClient();
        if (redisClient && redisClient.status === 'ready') {
            await redisClient.publish(shared_1.WS_EVENTS.PAPER_POSITION_CLOSED, JSON.stringify({
                positionId: pos.id,
                contractSymbol: pos.contractSymbol,
                exitPrice: finalExitPrice,
                realizedPnL,
                realizedR,
                exitReason,
                closedAt: exitTime.toISOString(),
            }));
        }
    }
};
exports.PositionMonitorProcessor = PositionMonitorProcessor;
exports.PositionMonitorProcessor = PositionMonitorProcessor = PositionMonitorProcessor_1 = __decorate([
    (0, bullmq_1.Processor)(shared_1.BULLMQ_QUEUES.POSITION_MONITORING),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        redis_service_1.RedisService])
], PositionMonitorProcessor);
//# sourceMappingURL=position-monitor.processor.js.map