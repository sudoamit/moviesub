"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var PaperTradingService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaperTradingService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../common/prisma/prisma.service");
const candles_service_1 = require("../candles/candles.service");
const real_market_streamer_service_1 = require("../market-data/real-market-streamer.service");
const trading_engine_1 = require("@quant/trading-engine");
const shared_1 = require("@quant/shared");
const library_1 = require("@prisma/client/runtime/library");
const crypto = __importStar(require("crypto"));
__exportStar(require("./execution-provider.interface"), exports);
let PaperTradingService = PaperTradingService_1 = class PaperTradingService {
    prisma;
    candlesService;
    realMarketStreamer;
    logger = new common_1.Logger(PaperTradingService_1.name);
    constructor(prisma, candlesService, realMarketStreamer) {
        this.prisma = prisma;
        this.candlesService = candlesService;
        this.realMarketStreamer = realMarketStreamer;
        this.logger.log('Persistent Database-Backed Paper Trading Service Initialized.');
    }
    /**
     * Retrieves or initializes the primary PaperAccount from PostgreSQL.
     */
    async getOrCreateAccount() {
        let account = await this.prisma.paperAccount.findFirst({
            where: { isActive: true },
        });
        if (!account) {
            account = await this.prisma.paperAccount.create({
                data: {
                    name: 'Primary Paper Account',
                    currency: 'INR',
                    initialCapital: new library_1.Decimal(1000000.0),
                    cashBalance: new library_1.Decimal(1000000.0),
                    usedMargin: new library_1.Decimal(0.0),
                    realizedPnL: new library_1.Decimal(0.0),
                    totalChargesPaid: new library_1.Decimal(0.0),
                    tradingMode: shared_1.TradingMode.PAPER,
                    isActive: true,
                },
            });
            this.logger.log(`Created primary paper trading account '${account.id}' with ₹10,00,000 balance.`);
        }
        return account;
    }
    /**
     * Retrieves system trading configuration or defaults.
     */
    async getSystemConfig() {
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
        return config;
    }
    /**
     * Calculates realistic Indian stock & crypto transaction charges (Brokerage, STT, GST, Exchange turnover)
     */
    calculateCharges(turnover, isCrypto) {
        if (isCrypto) {
            const brokerage = Number((turnover * 0.001).toFixed(2)); // 0.1% Binance maker/taker fee
            const totalCharges = brokerage;
            return {
                brokerage,
                stt: 0,
                exchangeTurnover: 0,
                gst: 0,
                sebiTurnover: 0,
                totalCharges,
            };
        }
        const brokerage = 20.0;
        const stt = Number((turnover * 0.000125).toFixed(2));
        const exchangeTurnover = Number((turnover * 0.0000345).toFixed(2));
        const gst = Number(((brokerage + exchangeTurnover) * 0.18).toFixed(2));
        const sebiTurnover = Number((turnover * 0.000001).toFixed(2));
        const totalCharges = Number((brokerage + stt + exchangeTurnover + gst + sebiTurnover).toFixed(2));
        return {
            brokerage,
            stt,
            exchangeTurnover,
            gst,
            sebiTurnover,
            totalCharges,
        };
    }
    normalizeSymbol(symbol) {
        return symbol.trim().toUpperCase();
    }
    toSignalDirection(direction) {
        return direction === 'BUY' ? shared_1.Direction.BULLISH : shared_1.Direction.BEARISH;
    }
    /**
     * Validates and fetches authoritative live market price without any hardcoded fallback.
     * Throws MarketDataUnavailableError if price is stale or missing.
     */
    async getValidatedMarketPrice(symbol, maxAgeSeconds = 5) {
        const sym = this.normalizeSymbol(symbol);
        // 1. Try real market streamer
        if (this.realMarketStreamer) {
            try {
                const ticker = this.realMarketStreamer.getValidatedTicker(sym, maxAgeSeconds);
                if (ticker && ticker.price > 0) {
                    return { price: ticker.price, timestamp: new Date(ticker.lastUpdated) };
                }
            }
            catch (err) {
                // Streamer check failed or threw stale error
                if (err instanceof shared_1.StaleMarketDataError || err instanceof shared_1.MarketDataUnavailableError) {
                    throw err;
                }
            }
        }
        // Fail closed: Never return fallback/hardcoded prices or historical candle closes for live execution
        throw new shared_1.MarketDataUnavailableError(sym, `No fresh live exchange market data available for execution. Hardcoded prices and historical candle fallbacks are strictly prohibited.`);
    }
    /**
     * Strictly Read-Only Portfolio Retrieval.
     * Does NOT modify positions or trigger exits on GET.
     */
    async getPortfolio() {
        const account = await this.getOrCreateAccount();
        const [openPositions, tradeHistory] = await Promise.all([
            this.prisma.paperPosition.findMany({
                where: {
                    accountId: account.id,
                    status: { in: [shared_1.PositionState.OPEN, shared_1.PositionState.PARTIALLY_CLOSED] },
                },
                orderBy: { openedAt: 'desc' },
            }),
            this.prisma.paperTrade.findMany({
                where: { accountId: account.id },
                orderBy: { exitTime: 'desc' },
                take: 50,
            }),
        ]);
        let totalUnrealized = 0.0;
        let totalUsedMargin = 0.0;
        const formattedPositions = [];
        for (const pos of openPositions) {
            let livePrice = Number(pos.currentPrice);
            try {
                const marketPriceObj = await this.getValidatedMarketPrice(pos.symbol, 30);
                livePrice = marketPriceObj.price;
            }
            catch {
                // keep pos.currentPrice if live price fetch fails on read-only view
            }
            const entryPrice = Number(pos.entryPrice);
            const quantity = Number(pos.quantity);
            const isBuy = pos.direction === shared_1.Direction.BULLISH;
            const priceDiff = isBuy ? livePrice - entryPrice : entryPrice - livePrice;
            const charges = pos.chargesJson || { totalCharges: 0 };
            const unrealizedPnL = Number((priceDiff * quantity - charges.totalCharges).toFixed(2));
            const stopLoss = pos.stopLoss ? Number(pos.stopLoss) : undefined;
            const initialStopLoss = pos.initialStopLoss ? Number(pos.initialStopLoss) : stopLoss;
            const riskAnchor = initialStopLoss ?? stopLoss;
            const riskDistance = riskAnchor ? Math.abs(entryPrice - riskAnchor) : 0;
            const unrealizedR = riskDistance > 0 ? Number((priceDiff / riskDistance).toFixed(2)) : 0;
            const notionalValue = Number((livePrice * quantity).toFixed(2));
            const usedMargin = Number(pos.usedMargin);
            // Trailing Stop evaluation (ONLY if explicit targets and SL exist on the position)
            let trailingStopState = undefined;
            if (initialStopLoss && pos.initialTarget1 && pos.initialTarget2) {
                const trailing = trading_engine_1.TrailingEngine.evaluate(entryPrice, Number(initialStopLoss), Number(pos.initialTarget1), Number(pos.initialTarget2), livePrice, isBuy ? 'BULLISH' : 'BEARISH');
                trailingStopState = {
                    stage: trailing.stage,
                    stageBadge: trailing.stageBadge,
                    currentStopLoss: trailing.currentStopLoss,
                    isRiskFree: trailing.isRiskFree,
                    partialBookedPercent: trailing.partialBookedPercent,
                    recommendedAction: trailing.recommendedAction,
                };
            }
            formattedPositions.push({
                id: pos.id,
                accountId: pos.accountId,
                symbol: pos.symbol,
                contractSymbol: pos.contractSymbol,
                instrumentType: pos.instrumentType,
                strike: pos.strike ? Number(pos.strike) : undefined,
                optionType: pos.optionType || undefined,
                direction: isBuy ? 'BUY' : 'SELL',
                quantity,
                entryPrice,
                entryTime: pos.entryTime.toISOString(),
                averageEntryPrice: entryPrice,
                currentPrice: livePrice,
                stopLoss,
                initialStopLoss,
                target1: pos.target1 ? Number(pos.target1) : undefined,
                target2: pos.target2 ? Number(pos.target2) : undefined,
                target3: pos.target3 ? Number(pos.target3) : undefined,
                initialTarget1: pos.initialTarget1 ? Number(pos.initialTarget1) : undefined,
                initialTarget2: pos.initialTarget2 ? Number(pos.initialTarget2) : undefined,
                initialTarget3: pos.initialTarget3 ? Number(pos.initialTarget3) : undefined,
                leverage: Number(pos.leverage),
                unrealizedPnL,
                unrealizedR,
                notionalValue,
                usedMargin,
                maxFavorableExcursion: Number(pos.maxFavorableExcursion),
                maxAdverseExcursion: Number(pos.maxAdverseExcursion),
                openedAt: pos.openedAt.toISOString(),
                status: pos.status,
                featureSnapshotJson: pos.featureSnapshotJson || undefined,
                trailingStopState,
                charges,
            });
            totalUnrealized += unrealizedPnL;
            totalUsedMargin += usedMargin;
        }
        const cashBalance = Number(account.cashBalance);
        const availableMargin = Number((cashBalance - totalUsedMargin).toFixed(2));
        const totalEquity = Number((cashBalance + totalUnrealized).toFixed(2));
        const formattedHistory = tradeHistory.map((t) => {
            const charges = t.chargesJson || { totalCharges: 0 };
            return {
                id: t.id,
                accountId: t.accountId,
                positionId: t.positionId || undefined,
                symbol: t.symbol,
                contractSymbol: t.contractSymbol,
                instrumentType: t.instrumentType,
                strike: t.strike ? Number(t.strike) : undefined,
                optionType: t.optionType || undefined,
                direction: t.direction === shared_1.Direction.BULLISH ? 'BUY' : 'SELL',
                quantity: Number(t.quantity),
                entryPrice: Number(t.entryPrice),
                exitPrice: Number(t.exitPrice),
                realizedPnL: Number(t.realizedPnL),
                realizedR: Number(t.realizedR),
                maxFavorableExcursion: Number(t.maxFavorableExcursion),
                maxAdverseExcursion: Number(t.maxAdverseExcursion),
                holdingDurationSeconds: t.holdingDurationSeconds,
                exitReason: t.exitReason,
                openedAt: t.entryTime.toISOString(),
                closedAt: t.exitTime.toISOString(),
                totalCharges: charges.totalCharges || 0,
                featureSnapshotJson: t.featureSnapshotJson || undefined,
                outcomeSnapshotJson: t.outcomeSnapshotJson || undefined,
                correlationId: t.correlationId,
            };
        });
        const totalTrades = formattedHistory.length;
        const winningTrades = formattedHistory.filter((t) => t.realizedPnL > 0).length;
        const losingTrades = formattedHistory.filter((t) => t.realizedPnL <= 0).length;
        const winRate = totalTrades > 0 ? Number(((winningTrades / totalTrades) * 100).toFixed(1)) : 0.0;
        const grossWins = formattedHistory
            .filter((t) => t.realizedPnL > 0)
            .reduce((acc, t) => acc + t.realizedPnL, 0);
        const grossLosses = Math.abs(formattedHistory.filter((t) => t.realizedPnL < 0).reduce((acc, t) => acc + t.realizedPnL, 0));
        const profitFactor = grossLosses > 0 ? Number((grossWins / grossLosses).toFixed(2)) : grossWins > 0 ? 99.9 : 0.0;
        return {
            accountId: account.id,
            initialCapital: Number(account.initialCapital),
            cashBalance,
            usedMargin: Number(totalUsedMargin.toFixed(2)),
            availableMargin,
            totalEquity,
            realizedPnL: Number(account.realizedPnL),
            unrealizedPnL: Number(totalUnrealized.toFixed(2)),
            totalChargesPaid: Number(account.totalChargesPaid),
            winRate,
            profitFactor,
            totalTrades,
            winningTrades,
            losingTrades,
            tradingMode: account.tradingMode,
            openPositions: formattedPositions,
            tradeHistory: formattedHistory,
        };
    }
    /**
     * Places a paper trading order with deterministic state machine, database persistence, and risk limit checks.
     */
    async placeOrder(req) {
        if (!req.symbol || !req.direction || !req.quantity || req.quantity <= 0) {
            throw new common_1.BadRequestException('Invalid order parameters: symbol, direction, and positive quantity required');
        }
        const symbol = this.normalizeSymbol(req.symbol);
        const isCrypto = symbol === 'BTCUSDT';
        const correlationId = req.correlationId || `corr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const instrumentType = req.instrumentType || (req.strike ? 'OPTION' : 'SPOT');
        const contractSymbol = req.contractSymbol ||
            (req.strike && req.optionType ? `${symbol} ${req.strike} ${req.optionType}` : symbol);
        const account = await this.getOrCreateAccount();
        const config = await this.getSystemConfig();
        // 1. Check Global Kill Switch
        if (config.emergencyStop) {
            await this.recordAudit('EMERGENCY_STOP', 'CONFIG', config.id, { reason: 'Order rejected due to emergency stop activation' }, correlationId);
            throw new common_1.BadRequestException('Trading is currently halted by Emergency Stop Kill Switch.');
        }
        // 2. Idempotency Check
        const idempotencyKey = req.idempotencyKey ||
            `${account.id}_${symbol}_${req.direction}_${req.quantity}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const existingOrder = await this.prisma.paperOrder.findUnique({
            where: { idempotencyKey },
            include: { positions: true },
        });
        if (existingOrder) {
            this.logger.warn(`[DUPLICATE ORDER DETECTED] Order with key '${idempotencyKey}' already processed.`);
            if (existingOrder.status === shared_1.OrderState.FILLED && existingOrder.positions.length > 0) {
                const pos = existingOrder.positions[0];
                return this.mapDbPositionToInterface(pos);
            }
            throw new common_1.BadRequestException(`Duplicate order detected with status: ${existingOrder.status}`);
        }
        // 3. Resolve Real Validated Execution Price with Mode Separation & Slippage
        let executionPrice = req.price;
        let sourceTimestamp = new Date();
        if (!executionPrice || executionPrice <= 0) {
            try {
                const marketPriceData = await this.getValidatedMarketPrice(symbol, config.maxMarketDataAgeSeconds || 5);
                executionPrice = marketPriceData.price;
                sourceTimestamp = marketPriceData.timestamp;
            }
            catch (err) {
                await this.prisma.paperOrder.create({
                    data: {
                        accountId: account.id,
                        symbol,
                        contractSymbol,
                        instrumentType,
                        direction: this.toSignalDirection(req.direction),
                        orderType: req.orderType || 'MARKET',
                        requestedQuantity: new library_1.Decimal(req.quantity),
                        status: shared_1.OrderState.REJECTED,
                        rejectionReason: shared_1.RiskRejectionReason.MARKET_DATA_UNAVAILABLE,
                        rejectionDetails: err.message,
                        idempotencyKey,
                        correlationId,
                    },
                });
                await this.recordAudit('ORDER_REJECTED', 'ORDER', idempotencyKey, { symbol, reason: err.message }, correlationId);
                throw new common_1.BadRequestException(`Order Rejected: ${err.message}`);
            }
        }
        // 4. Directional SL / TP Validation (Never silently create or alter SL/TP)
        const isBuy = req.direction === 'BUY';
        const stopLoss = req.stopLoss;
        const target1 = req.target1;
        const target2 = req.target2;
        const target3 = req.target3;
        // Check Missing Stop Loss
        if (stopLoss === undefined || stopLoss === null || stopLoss <= 0) {
            await this.rejectOrder(account.id, symbol, contractSymbol, instrumentType, req.direction, req.orderType, req.quantity, shared_1.RiskRejectionReason.MISSING_STOP_LOSS, 'Stop loss is required for paper trade execution. Default/fallback SL is prohibited.', idempotencyKey, correlationId);
            throw new common_1.BadRequestException('Order Rejected [MISSING_STOP_LOSS]: Stop loss is required.');
        }
        // Check Invalid Stop Loss
        if (isBuy && stopLoss >= executionPrice) {
            await this.rejectOrder(account.id, symbol, contractSymbol, instrumentType, req.direction, req.orderType, req.quantity, shared_1.RiskRejectionReason.INVALID_STOP_LOSS, `Stop loss (${stopLoss}) must be strictly below execution price (${executionPrice}) for BUY order`, idempotencyKey, correlationId);
            throw new common_1.BadRequestException(`Order Rejected [INVALID_STOP_LOSS]: Stop loss (${stopLoss}) must be below execution price (${executionPrice}) for BUY.`);
        }
        if (!isBuy && stopLoss <= executionPrice) {
            await this.rejectOrder(account.id, symbol, contractSymbol, instrumentType, req.direction, req.orderType, req.quantity, shared_1.RiskRejectionReason.INVALID_STOP_LOSS, `Stop loss (${stopLoss}) must be strictly above execution price (${executionPrice}) for SELL order`, idempotencyKey, correlationId);
            throw new common_1.BadRequestException(`Order Rejected [INVALID_STOP_LOSS]: Stop loss (${stopLoss}) must be above execution price (${executionPrice}) for SELL.`);
        }
        // Check Missing Take Profit (target1)
        if (target1 === undefined || target1 === null || target1 <= 0) {
            await this.rejectOrder(account.id, symbol, contractSymbol, instrumentType, req.direction, req.orderType, req.quantity, shared_1.RiskRejectionReason.MISSING_TAKE_PROFIT, 'Take profit (target1) is required for paper trade execution. Default/fallback TP is prohibited.', idempotencyKey, correlationId);
            throw new common_1.BadRequestException('Order Rejected [MISSING_TAKE_PROFIT]: Take profit is required.');
        }
        // Check Invalid Take Profit (target1)
        if (isBuy && target1 <= executionPrice) {
            await this.rejectOrder(account.id, symbol, contractSymbol, instrumentType, req.direction, req.orderType, req.quantity, shared_1.RiskRejectionReason.INVALID_TAKE_PROFIT, `Target 1 (${target1}) must be strictly above execution price (${executionPrice}) for BUY order`, idempotencyKey, correlationId);
            throw new common_1.BadRequestException(`Order Rejected [INVALID_TAKE_PROFIT]: Target 1 (${target1}) must be above execution price (${executionPrice}) for BUY.`);
        }
        if (!isBuy && target1 >= executionPrice) {
            await this.rejectOrder(account.id, symbol, contractSymbol, instrumentType, req.direction, req.orderType, req.quantity, shared_1.RiskRejectionReason.INVALID_TAKE_PROFIT, `Target 1 (${target1}) must be strictly below execution price (${executionPrice}) for SELL order`, idempotencyKey, correlationId);
            throw new common_1.BadRequestException(`Order Rejected [INVALID_TAKE_PROFIT]: Target 1 (${target1}) must be below execution price (${executionPrice}) for SELL.`);
        }
        // Check optional target2 & target3 relative validity
        if (target2 !== undefined && target2 !== null) {
            if ((isBuy && target2 <= target1) || (!isBuy && target2 >= target1)) {
                await this.rejectOrder(account.id, symbol, contractSymbol, instrumentType, req.direction, req.orderType, req.quantity, shared_1.RiskRejectionReason.INVALID_TAKE_PROFIT, `Target 2 (${target2}) is invalid relative to Target 1 (${target1})`, idempotencyKey, correlationId);
                throw new common_1.BadRequestException(`Order Rejected [INVALID_TAKE_PROFIT]: Invalid Target 2 relative to Target 1.`);
            }
        }
        // 5. Hard Risk Limits Check
        // 5.1 Max Open Positions Limit
        const openPositionsCount = await this.prisma.paperPosition.count({
            where: {
                accountId: account.id,
                status: { in: [shared_1.PositionState.OPEN, shared_1.PositionState.PARTIALLY_CLOSED] },
            },
        });
        if (openPositionsCount >= config.maxOpenPositions) {
            await this.rejectOrder(account.id, symbol, contractSymbol, instrumentType, req.direction, req.orderType, req.quantity, shared_1.RiskRejectionReason.MAX_OPEN_POSITIONS, `Maximum open positions limit reached (${openPositionsCount} >= ${config.maxOpenPositions})`, idempotencyKey, correlationId);
            throw new common_1.BadRequestException(`Order Rejected [MAX_OPEN_POSITIONS]: Maximum open positions limit reached (${config.maxOpenPositions}).`);
        }
        // 5.2 Max Trades Per Day Limit
        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0);
        const todayOrderCount = await this.prisma.paperOrder.count({
            where: {
                accountId: account.id,
                createdAt: { gte: startOfDay },
                status: { in: [shared_1.OrderState.FILLED, shared_1.OrderState.SUBMITTED, shared_1.OrderState.PARTIALLY_FILLED] },
            },
        });
        if (todayOrderCount >= config.maxTradesPerDay) {
            await this.rejectOrder(account.id, symbol, contractSymbol, instrumentType, req.direction, req.orderType, req.quantity, shared_1.RiskRejectionReason.MAX_TRADES_PER_DAY, `Maximum trades per day limit reached (${todayOrderCount} >= ${config.maxTradesPerDay})`, idempotencyKey, correlationId);
            throw new common_1.BadRequestException(`Order Rejected [MAX_TRADES_PER_DAY]: Maximum trades per day reached (${config.maxTradesPerDay}).`);
        }
        // 5.3 Max Consecutive Losses Limit
        const recentTrades = await this.prisma.paperTrade.findMany({
            where: { accountId: account.id },
            orderBy: { exitTime: 'desc' },
            take: config.maxConsecutiveLosses,
        });
        if (recentTrades.length >= config.maxConsecutiveLosses &&
            recentTrades.every((t) => Number(t.realizedPnL) <= 0)) {
            await this.rejectOrder(account.id, symbol, contractSymbol, instrumentType, req.direction, req.orderType, req.quantity, shared_1.RiskRejectionReason.MAX_CONSECUTIVE_LOSSES, `Maximum consecutive losses limit reached (${config.maxConsecutiveLosses} consecutive losses)`, idempotencyKey, correlationId);
            throw new common_1.BadRequestException(`Order Rejected [MAX_CONSECUTIVE_LOSSES]: Cool-off triggered after ${config.maxConsecutiveLosses} consecutive losses.`);
        }
        // 5.4 Position Risk Limit
        const riskPerUnit = Math.abs(executionPrice - stopLoss);
        const totalPositionRisk = riskPerUnit * req.quantity;
        const initialCapital = Number(account.initialCapital);
        const maxAllowedRiskAmount = initialCapital * (Number(config.maxPositionRiskPercent) / 100);
        if (totalPositionRisk > maxAllowedRiskAmount) {
            await this.rejectOrder(account.id, symbol, contractSymbol, instrumentType, req.direction, req.orderType, req.quantity, shared_1.RiskRejectionReason.POSITION_RISK_LIMIT, `Position risk amount ₹${totalPositionRisk.toFixed(2)} exceeds allowed limit ₹${maxAllowedRiskAmount.toFixed(2)} (${config.maxPositionRiskPercent}% of ₹${initialCapital})`, idempotencyKey, correlationId);
            throw new common_1.BadRequestException(`Order Rejected [POSITION_RISK_LIMIT]: Risk ₹${totalPositionRisk.toFixed(2)} exceeds allowed limit ₹${maxAllowedRiskAmount.toFixed(2)}.`);
        }
        // 5.5 Max Daily Loss Limit
        const todayTrades = await this.prisma.paperTrade.findMany({
            where: {
                accountId: account.id,
                exitTime: { gte: startOfDay },
            },
        });
        const todayRealizedPnL = todayTrades.reduce((acc, t) => acc + Number(t.realizedPnL), 0);
        const maxDailyLossAllowed = initialCapital * (Number(config.maxDailyLossPercent) / 100);
        if (todayRealizedPnL < -maxDailyLossAllowed) {
            await this.rejectOrder(account.id, symbol, contractSymbol, instrumentType, req.direction, req.orderType, req.quantity, shared_1.RiskRejectionReason.DAILY_LOSS_LIMIT, `Daily loss limit breached: Realized ₹${todayRealizedPnL.toFixed(2)} exceeds max daily loss ₹${maxDailyLossAllowed.toFixed(2)} (${config.maxDailyLossPercent}%)`, idempotencyKey, correlationId);
            throw new common_1.BadRequestException(`Order Rejected [DAILY_LOSS_LIMIT]: Daily loss limit breached (₹${todayRealizedPnL.toFixed(2)} / ₹${maxDailyLossAllowed.toFixed(2)}).`);
        }
        // 5.6 Max Leverage Check
        if (req.leverage && req.leverage > Number(config.maxLeverage)) {
            await this.rejectOrder(account.id, symbol, contractSymbol, instrumentType, req.direction, req.orderType, req.quantity, shared_1.RiskRejectionReason.MAX_LEVERAGE, `Requested leverage ${req.leverage}x exceeds maximum configured leverage ${config.maxLeverage}x`, idempotencyKey, correlationId);
            throw new common_1.BadRequestException(`Order Rejected [MAX_LEVERAGE]: Requested leverage ${req.leverage}x exceeds limit ${config.maxLeverage}x.`);
        }
        // 5.7 Slippage Simulation & Margin Accounting
        const slippageResult = shared_1.ExecutionPriceResolver.calculateSlippage(executionPrice, req.direction, config.maxSlippageBps || 50);
        const finalFillPrice = slippageResult.fillPrice;
        const slippageAmount = slippageResult.slippageAmount;
        const turnover = finalFillPrice * req.quantity;
        const charges = this.calculateCharges(turnover, isCrypto);
        const effLeverage = Math.max(1, Math.min(req.leverage || 5, Number(config.maxLeverage)));
        const requiredMargin = Number((turnover / effLeverage + charges.totalCharges).toFixed(2));
        const maxExposureAllowed = initialCapital * (Number(config.maxTotalExposurePercent) / 100);
        // 6. Execute Order & Persist Position inside Atomic Concurrency-Safe Transaction
        const entryTime = new Date();
        const result = await this.prisma.$transaction(async (tx) => {
            // Concurrency Lock: Re-read account inside atomic transaction
            const txAccount = await tx.paperAccount.findUnique({
                where: { id: account.id },
            });
            if (!txAccount) {
                throw new common_1.BadRequestException('Trading account not found');
            }
            const txCash = Number(txAccount.cashBalance);
            const txUsedMargin = Number(txAccount.usedMargin);
            const txAvailable = txCash - txUsedMargin;
            if (txAvailable < requiredMargin) {
                throw new common_1.BadRequestException(`[INSUFFICIENT_MARGIN] Concurrency check failed. Required: ₹${requiredMargin.toFixed(2)}, Available: ₹${txAvailable.toFixed(2)}`);
            }
            const totalExposureAfterOrder = txUsedMargin + requiredMargin;
            if (totalExposureAfterOrder > maxExposureAllowed) {
                throw new common_1.BadRequestException(`[TOTAL_EXPOSURE_LIMIT] Concurrency check failed. Total exposure ₹${totalExposureAfterOrder.toFixed(2)} exceeds limit ₹${maxExposureAllowed.toFixed(2)}`);
            }
            // Create PaperOrder (FILLED)
            const order = await tx.paperOrder.create({
                data: {
                    accountId: account.id,
                    symbol,
                    contractSymbol,
                    instrumentType,
                    strike: req.strike ? new library_1.Decimal(req.strike) : null,
                    optionType: req.optionType,
                    direction: this.toSignalDirection(req.direction),
                    orderType: req.orderType || 'MARKET',
                    requestedQuantity: new library_1.Decimal(req.quantity),
                    filledQuantity: new library_1.Decimal(req.quantity),
                    price: new library_1.Decimal(finalFillPrice),
                    stopLoss: new library_1.Decimal(stopLoss),
                    target1: new library_1.Decimal(target1),
                    target2: target2 ? new library_1.Decimal(target2) : null,
                    target3: target3 ? new library_1.Decimal(target3) : null,
                    leverage: new library_1.Decimal(effLeverage),
                    status: shared_1.OrderState.FILLED,
                    idempotencyKey,
                    signalId: req.signalId,
                    correlationId,
                    submittedAt: entryTime,
                },
            });
            // Create PaperFill with slippage & executionPriceSource
            const fill = await tx.paperFill.create({
                data: {
                    orderId: order.id,
                    fillPrice: new library_1.Decimal(finalFillPrice),
                    fillQuantity: new library_1.Decimal(req.quantity),
                    fee: new library_1.Decimal(charges.totalCharges),
                    feeBreakdownJson: charges,
                    slippage: new library_1.Decimal(slippageAmount),
                    executionPriceSource: shared_1.ExecutionPriceSource.LIVE_TICK,
                    liquidityType: 'TAKER',
                    sourceTimestamp,
                    fillTimestamp: entryTime,
                    correlationId,
                },
            });
            // Create PaperPosition
            const position = await tx.paperPosition.create({
                data: {
                    accountId: account.id,
                    orderId: order.id,
                    symbol,
                    contractSymbol,
                    instrumentType,
                    strike: req.strike ? new library_1.Decimal(req.strike) : null,
                    optionType: req.optionType,
                    direction: this.toSignalDirection(req.direction),
                    quantity: new library_1.Decimal(req.quantity),
                    entryPrice: new library_1.Decimal(finalFillPrice),
                    entryTime,
                    currentPrice: new library_1.Decimal(finalFillPrice),
                    stopLoss: new library_1.Decimal(stopLoss),
                    initialStopLoss: new library_1.Decimal(stopLoss),
                    target1: new library_1.Decimal(target1),
                    target2: target2 ? new library_1.Decimal(target2) : null,
                    target3: target3 ? new library_1.Decimal(target3) : null,
                    initialTarget1: new library_1.Decimal(target1),
                    initialTarget2: target2 ? new library_1.Decimal(target2) : null,
                    initialTarget3: target3 ? new library_1.Decimal(target3) : null,
                    leverage: new library_1.Decimal(effLeverage),
                    usedMargin: new library_1.Decimal(requiredMargin),
                    unrealizedPnL: new library_1.Decimal(-charges.totalCharges),
                    unrealizedR: new library_1.Decimal(0.0),
                    maxFavorableExcursion: new library_1.Decimal(0.0),
                    maxAdverseExcursion: new library_1.Decimal(0.0),
                    status: shared_1.PositionState.OPEN,
                    chargesJson: charges,
                    featureSnapshotJson: req.featureSnapshotJson || undefined,
                    openedAt: entryTime,
                    correlationId,
                },
            });
            // Atomically update PaperAccount balance & usedMargin
            await tx.paperAccount.update({
                where: { id: account.id },
                data: {
                    cashBalance: { decrement: charges.totalCharges },
                    usedMargin: { increment: requiredMargin },
                    totalChargesPaid: { increment: charges.totalCharges },
                },
            });
            // Create Audit Events
            await tx.auditEvent.createMany({
                data: [
                    {
                        actor: 'SYSTEM',
                        service: 'PAPER_TRADING',
                        eventType: 'ORDER_FILLED',
                        entityType: 'ORDER',
                        entityId: order.id,
                        payloadJson: {
                            symbol,
                            direction: req.direction,
                            quantity: req.quantity,
                            executionPrice: finalFillPrice,
                            slippage: slippageAmount,
                        },
                        correlationId,
                    },
                    {
                        actor: 'SYSTEM',
                        service: 'PAPER_TRADING',
                        eventType: 'POSITION_OPENED',
                        entityType: 'POSITION',
                        entityId: position.id,
                        payloadJson: { contractSymbol, entryPrice: finalFillPrice, requiredMargin },
                        correlationId,
                    },
                ],
            });
            return position;
        });
        this.logger.log(`✓ [PERSISTED PAPER POSITION OPENED] ${req.direction} ${req.quantity} ${contractSymbol} @ ₹${finalFillPrice.toFixed(2)} (slip: ₹${slippageAmount.toFixed(2)}) (${effLeverage}x) | Margin: ₹${requiredMargin.toFixed(2)} | Corr: ${correlationId}`);
        return this.mapDbPositionToInterface(result);
    }
    mapDbTradeToInterface(trade) {
        const charges = trade.chargesJson || { totalCharges: 0 };
        return {
            id: trade.id,
            accountId: trade.accountId,
            positionId: trade.positionId || undefined,
            symbol: trade.symbol,
            contractSymbol: trade.contractSymbol,
            instrumentType: trade.instrumentType,
            strike: trade.strike ? Number(trade.strike) : undefined,
            optionType: trade.optionType || undefined,
            direction: trade.direction === shared_1.Direction.BULLISH ? 'BUY' : 'SELL',
            quantity: Number(trade.quantity),
            entryPrice: Number(trade.entryPrice),
            exitPrice: Number(trade.exitPrice),
            realizedPnL: Number(trade.realizedPnL),
            realizedR: Number(trade.realizedR),
            maxFavorableExcursion: trade.maxFavorableExcursion ? Number(trade.maxFavorableExcursion) : undefined,
            maxAdverseExcursion: trade.maxAdverseExcursion ? Number(trade.maxAdverseExcursion) : undefined,
            holdingDurationSeconds: trade.holdingDurationSeconds || 0,
            exitReason: trade.exitReason,
            openedAt: new Date(trade.entryTime).toISOString(),
            closedAt: new Date(trade.exitTime).toISOString(),
            totalCharges: Number(charges.totalCharges || 0),
            featureSnapshotJson: trade.featureSnapshotJson || undefined,
            outcomeSnapshotJson: trade.outcomeSnapshotJson || undefined,
            correlationId: trade.correlationId,
        };
    }
    /**
     * Closes an existing paper position, books realized P&L, deducts exit charges, and persists PaperTrade in PostgreSQL.
     */
    async closePosition(positionId, exitReason = 'Manual Exit', options, correlationIdOverride) {
        let exitPriceOverride;
        let allowPriceOverride = false;
        let correlationIdOpt;
        if (typeof options === 'number') {
            exitPriceOverride = options;
        }
        else if (options && typeof options === 'object') {
            exitPriceOverride = options.exitPriceOverride;
            allowPriceOverride = options.allowPriceOverride === true;
            correlationIdOpt = options.correlationId;
        }
        const pos = await this.prisma.paperPosition.findUnique({
            where: { id: positionId },
            include: { account: true },
        });
        if (!pos) {
            throw new common_1.NotFoundException(`Active position with ID '${positionId}' not found`);
        }
        if (pos.status === shared_1.PositionState.CLOSED) {
            // Idempotent retry: recognize and return existing completed PaperTrade
            const existingTrade = await this.prisma.paperTrade.findFirst({
                where: { positionId: pos.id },
                orderBy: { exitTime: 'desc' },
            });
            if (existingTrade) {
                return this.mapDbTradeToInterface(existingTrade);
            }
            throw new common_1.NotFoundException(`Active position with ID '${positionId}' is already closed, but no trade record exists.`);
        }
        if (pos.status === shared_1.PositionState.CLOSING) {
            throw new common_1.BadRequestException(`Position '${positionId}' is currently being closed by another request.`);
        }
        const correlationId = correlationIdOverride || correlationIdOpt || pos.correlationId || `corr_${Date.now()}`;
        const symbol = pos.symbol;
        const isCrypto = symbol === 'BTCUSDT';
        const config = await this.getSystemConfig();
        // Resolve live exit price with strict fail-closed validation & LIVE_TICK provenance
        let exitPrice;
        let sourceTimestamp = new Date();
        let priceSource = shared_1.ExecutionPriceSource.LIVE_TICK;
        if (allowPriceOverride && exitPriceOverride && exitPriceOverride > 0) {
            exitPrice = exitPriceOverride;
            priceSource = shared_1.ExecutionPriceSource.SIMULATED_FILL;
        }
        else {
            try {
                const marketPriceData = await this.getValidatedMarketPrice(symbol, config.maxMarketDataAgeSeconds || 5);
                exitPrice = marketPriceData.price;
                sourceTimestamp = marketPriceData.timestamp;
            }
            catch (err) {
                this.logger.error(`[EXIT REJECTED] Cannot close position '${pos.id}' for '${symbol}': ${err.message}`);
                await this.prisma.paperPosition.update({
                    where: { id: pos.id },
                    data: { status: shared_1.PositionState.EXIT_PENDING },
                });
                throw new common_1.BadRequestException(`Cannot close position for ${symbol}: Real-time market data unavailable (${err.message}). Position marked EXIT_PENDING.`);
            }
        }
        // Apply exit slippage simulation
        const exitSlippage = shared_1.ExecutionPriceResolver.calculateSlippage(exitPrice, pos.direction === shared_1.Direction.BULLISH ? 'SELL' : 'BUY', config.maxSlippageBps || 50);
        const finalExitPrice = exitSlippage.fillPrice;
        const exitTime = new Date();
        const quantity = Number(pos.quantity);
        const entryPrice = Number(pos.entryPrice);
        const exitTurnover = finalExitPrice * quantity;
        const exitCharges = this.calculateCharges(exitTurnover, isCrypto);
        const entryCharges = pos.chargesJson || { totalCharges: 0 };
        const totalCharges = Number((entryCharges.totalCharges + exitCharges.totalCharges).toFixed(2));
        const isBuy = pos.direction === shared_1.Direction.BULLISH;
        const priceDiff = isBuy ? finalExitPrice - entryPrice : entryPrice - finalExitPrice;
        const grossPnL = priceDiff * quantity;
        const realizedPnL = Number((grossPnL - totalCharges).toFixed(2));
        const stopLoss = pos.stopLoss ? Number(pos.stopLoss) : undefined;
        const initialStopLoss = pos.initialStopLoss ? Number(pos.initialStopLoss) : stopLoss;
        const riskAnchor = initialStopLoss ?? stopLoss;
        const riskDistance = riskAnchor ? Math.abs(entryPrice - riskAnchor) : 0;
        const realizedR = riskDistance > 0 ? Number((priceDiff / riskDistance).toFixed(2)) : 0;
        const holdingDurationSeconds = Math.max(0, Math.floor((exitTime.getTime() - pos.entryTime.getTime()) / 1000));
        // Determine outcome classification
        let outcomeClassification = 'MANUAL';
        if (exitReason.includes('TP3'))
            outcomeClassification = 'WIN_TP3_RUNNER';
        else if (exitReason.includes('TP2'))
            outcomeClassification = 'WIN_TP2';
        else if (exitReason.includes('TP1'))
            outcomeClassification = 'WIN_TP1';
        else if (exitReason.includes('Breakeven'))
            outcomeClassification = 'BREAKEVEN';
        else if (exitReason.includes('Stop Loss') || exitReason.includes('SL'))
            outcomeClassification = 'LOSS_SL';
        // Atomic Database Transaction for Position Closure (with Concurrency / Double-Close Guard)
        const trade = await this.prisma.$transaction(async (tx) => {
            // 1. Atomic state transition: OPEN/EXIT_PENDING/PARTIALLY_CLOSED -> CLOSING
            const updated = await tx.paperPosition.updateMany({
                where: {
                    id: pos.id,
                    status: { in: [shared_1.PositionState.OPEN, shared_1.PositionState.PARTIALLY_CLOSED, shared_1.PositionState.EXIT_PENDING] },
                },
                data: {
                    status: shared_1.PositionState.CLOSING,
                },
            });
            if (updated.count === 0) {
                // Concurrency check: another worker/thread already closed this position!
                const existingTrade = await tx.paperTrade.findFirst({
                    where: { positionId: pos.id },
                    orderBy: { exitTime: 'desc' },
                });
                if (existingTrade) {
                    return existingTrade;
                }
                throw new common_1.BadRequestException(`Position '${pos.id}' was already closed.`);
            }
            // 2. Mark Position CLOSED
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
            // 3. Create PaperTrade Record
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
                        executionPriceSource: priceSource,
                        sourceTimestamp: sourceTimestamp.toISOString(),
                        livePrice: exitPrice,
                        exitPrice: finalExitPrice,
                        slippageBps: exitSlippage.slippageBps,
                        slippageAmount: exitSlippage.slippageAmount,
                        exitReason,
                        realizedPnL,
                        realizedR,
                        holdingDurationSeconds,
                        outcomeClassification,
                        exitTime: exitTime.toISOString(),
                        correlationId,
                    },
                    outcomeClassification,
                    correlationId,
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
                    actor: 'SYSTEM',
                    service: 'PAPER_TRADING',
                    eventType: 'POSITION_CLOSED',
                    entityType: 'TRADE',
                    entityId: tradeRecord.id,
                    payloadJson: {
                        contractSymbol: pos.contractSymbol,
                        entryPrice,
                        exitPrice: finalExitPrice,
                        executionPriceSource: priceSource,
                        sourceTimestamp: sourceTimestamp.toISOString(),
                        realizedPnL,
                        realizedR,
                        exitReason,
                    },
                    correlationId,
                },
            });
            return tradeRecord;
        });
        this.logger.log(`✓ [PERSISTED PAPER POSITION CLOSED] ${pos.contractSymbol} @ ₹${finalExitPrice.toFixed(2)} | Net PnL: ₹${realizedPnL.toFixed(2)} (${realizedR}R) [${exitReason}]`);
        return this.mapDbTradeToInterface(trade);
    }
    /**
     * Resets the entire paper trading account balance and closes all active positions.
     */
    async resetPortfolio(initialCapital = 1000000.0) {
        const account = await this.getOrCreateAccount();
        await this.prisma.$transaction(async (tx) => {
            // Close all open positions
            await tx.paperPosition.updateMany({
                where: {
                    accountId: account.id,
                    status: { in: [shared_1.PositionState.OPEN, shared_1.PositionState.PARTIALLY_CLOSED] },
                },
                data: {
                    status: shared_1.PositionState.CLOSED,
                    closedAt: new Date(),
                },
            });
            // Reset Account Balances
            await tx.paperAccount.update({
                where: { id: account.id },
                data: {
                    initialCapital: new library_1.Decimal(initialCapital),
                    cashBalance: new library_1.Decimal(initialCapital),
                    usedMargin: new library_1.Decimal(0.0),
                    realizedPnL: new library_1.Decimal(0.0),
                    totalChargesPaid: new library_1.Decimal(0.0),
                },
            });
            // Audit Log
            await tx.auditEvent.create({
                data: {
                    actor: 'USER',
                    service: 'PAPER_TRADING',
                    eventType: 'ACCOUNT_RESET',
                    entityType: 'ACCOUNT',
                    entityId: account.id,
                    payloadJson: { initialCapital },
                    correlationId: `reset_${Date.now()}`,
                },
            });
        });
        this.logger.log(`Paper Trading Account '${account.id}' reset to initial capital: ₹${initialCapital.toLocaleString()}`);
        return this.getPortfolio();
    }
    async rejectOrder(accountId, symbol, contractSymbol, instrumentType, direction, orderType, quantity, rejectionReason, rejectionDetails, idempotencyKey, correlationId) {
        try {
            await this.prisma.paperOrder.create({
                data: {
                    accountId,
                    symbol,
                    contractSymbol,
                    instrumentType,
                    direction: this.toSignalDirection(direction),
                    orderType: orderType || 'MARKET',
                    requestedQuantity: new library_1.Decimal(quantity),
                    status: shared_1.OrderState.REJECTED,
                    rejectionReason,
                    rejectionDetails,
                    idempotencyKey,
                    correlationId,
                },
            });
            await this.recordAudit('ORDER_REJECTED', 'ORDER', idempotencyKey, { symbol, rejectionReason, rejectionDetails }, correlationId);
        }
        catch (e) {
            this.logger.warn(`Failed to record rejected order record: ${e.message}`);
        }
    }
    async recordAudit(eventType, entityType, entityId, payload, correlationId) {
        try {
            await this.prisma.auditEvent.create({
                data: {
                    actor: 'SYSTEM',
                    service: 'PAPER_TRADING',
                    eventType,
                    entityType,
                    entityId,
                    payloadJson: payload,
                    correlationId,
                },
            });
        }
        catch (e) {
            this.logger.warn(`Failed to write audit event: ${e.message}`);
        }
    }
    mapDbPositionToInterface(pos) {
        const charges = pos.chargesJson || { totalCharges: 0 };
        return {
            id: pos.id,
            accountId: pos.accountId,
            symbol: pos.symbol,
            contractSymbol: pos.contractSymbol,
            instrumentType: pos.instrumentType,
            strike: pos.strike ? Number(pos.strike) : undefined,
            optionType: pos.optionType || undefined,
            direction: pos.direction === shared_1.Direction.BULLISH ? 'BUY' : 'SELL',
            quantity: Number(pos.quantity),
            entryPrice: Number(pos.entryPrice),
            entryTime: pos.entryTime instanceof Date ? pos.entryTime.toISOString() : String(pos.entryTime),
            averageEntryPrice: Number(pos.entryPrice),
            currentPrice: Number(pos.currentPrice),
            stopLoss: pos.stopLoss ? Number(pos.stopLoss) : undefined,
            initialStopLoss: pos.initialStopLoss ? Number(pos.initialStopLoss) : undefined,
            target1: pos.target1 ? Number(pos.target1) : undefined,
            target2: pos.target2 ? Number(pos.target2) : undefined,
            target3: pos.target3 ? Number(pos.target3) : undefined,
            initialTarget1: pos.initialTarget1 ? Number(pos.initialTarget1) : undefined,
            initialTarget2: pos.initialTarget2 ? Number(pos.initialTarget2) : undefined,
            initialTarget3: pos.initialTarget3 ? Number(pos.initialTarget3) : undefined,
            leverage: Number(pos.leverage),
            unrealizedPnL: Number(pos.unrealizedPnL),
            unrealizedR: Number(pos.unrealizedR),
            notionalValue: Number((Number(pos.currentPrice) * Number(pos.quantity)).toFixed(2)),
            usedMargin: Number(pos.usedMargin),
            maxFavorableExcursion: Number(pos.maxFavorableExcursion),
            maxAdverseExcursion: Number(pos.maxAdverseExcursion),
            openedAt: pos.openedAt instanceof Date ? pos.openedAt.toISOString() : String(pos.openedAt),
            status: pos.status,
            featureSnapshotJson: pos.featureSnapshotJson || undefined,
            charges,
        };
    }
};
exports.PaperTradingService = PaperTradingService;
exports.PaperTradingService = PaperTradingService = PaperTradingService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(2, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        candles_service_1.CandlesService,
        real_market_streamer_service_1.RealMarketStreamerService])
], PaperTradingService);
//# sourceMappingURL=paper-trading.service.js.map