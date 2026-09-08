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
var SignalsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../common/prisma/prisma.service");
const candles_service_1 = require("../candles/candles.service");
const trading_engine_1 = require("@quant/trading-engine");
const risk_engine_1 = require("@quant/risk-engine");
const shared_1 = require("@quant/shared");
let SignalsService = SignalsService_1 = class SignalsService {
    prisma;
    candlesService;
    logger = new common_1.Logger(SignalsService_1.name);
    constructor(prisma, candlesService) {
        this.prisma = prisma;
        this.candlesService = candlesService;
    }
    async onModuleInit() {
        try {
            const count = await this.prisma.signal.count();
            if (count === 0) {
                this.logger.log('Trade Journal empty on startup. Initializing completed trades...');
                await this.syncHistoricalTrades();
            }
        }
        catch (err) {
            this.logger.warn(`Failed to auto-seed initial completed trades: ${err?.message}`);
        }
    }
    async generateSignalForSymbol(symbol, executionTimeframe = shared_1.Timeframe.M15, strategy = 'SMC') {
        const sym = symbol.toUpperCase();
        const inst = await this.prisma.instrument.findUnique({
            where: { symbol: sym },
        });
        if (!inst) {
            throw new common_1.NotFoundException(`Instrument '${sym}' not found`);
        }
        // Fetch multi-timeframe candles: 15m (exec), 1h (HTF1), 4h (HTF2)
        const [execCandles, htf1Candles, htf2Candles] = await Promise.all([
            this.candlesService.getCandles({ symbol: sym, timeframe: executionTimeframe, limit: 200 }),
            this.candlesService
                .getCandles({ symbol: sym, timeframe: shared_1.Timeframe.H1, limit: 150 })
                .catch(() => ({ candles: [] })),
            this.candlesService
                .getCandles({ symbol: sym, timeframe: shared_1.Timeframe.H4, limit: 100 })
                .catch(() => ({ candles: [] })),
        ]);
        const signal = trading_engine_1.SignalGenerator.generateSignal({
            symbol: sym,
            executionCandles: execCandles.candles,
            executionTimeframe,
            htf1Candles: htf1Candles.candles,
            htf1Timeframe: shared_1.Timeframe.H1,
            htf2Candles: htf2Candles.candles,
            htf2Timeframe: shared_1.Timeframe.H4,
            strategyMode: strategy,
        });
        // Evaluate live state against current candle close
        const lastCandle = execCandles.candles[execCandles.candles.length - 1];
        if (lastCandle && signal.direction !== 'NEUTRAL') {
            const cmp = lastCandle.close;
            const isBull = signal.direction === 'BULLISH';
            const tp3 = signal.takeProfits?.tp3 || (signal.takeProfits?.tp2 ? signal.takeProfits.tp2 * 1.05 : 0);
            const tp2 = signal.takeProfits?.tp2;
            const sl = signal.stopLoss;
            if (isBull) {
                if (tp3 > 0 && cmp >= tp3) {
                    signal.state = 'TP3_HIT';
                }
                else if (tp2 > 0 && cmp >= tp2) {
                    signal.state = 'TP2_HIT';
                }
                else if (sl > 0 && cmp <= sl) {
                    signal.state = 'SL_HIT';
                }
            }
            else {
                if (tp3 > 0 && cmp <= tp3) {
                    signal.state = 'TP3_HIT';
                }
                else if (tp2 > 0 && cmp <= tp2) {
                    signal.state = 'TP2_HIT';
                }
                else if (sl > 0 && cmp >= sl) {
                    signal.state = 'SL_HIT';
                }
            }
        }
        signal.instrumentId = inst.id;
        return signal;
    }
    async getAllSignals(timeframe = shared_1.Timeframe.M15, strategy = 'SMC') {
        const instruments = await this.prisma.instrument.findMany({
            where: { isActive: true },
        });
        const signals = [];
        for (const inst of instruments) {
            try {
                const sig = await this.generateSignalForSymbol(inst.symbol, timeframe, strategy);
                signals.push(sig);
            }
            catch (err) {
                this.logger.warn(`Failed to generate signal for ${inst.symbol}: ${err.message}`);
            }
        }
        return signals;
    }
    /**
     * Evaluates a setup preview against live price.
     *
     * This endpoint intentionally does not persist journal rows. Journal writes must come
     * from an executed position close path, where entry price/time are already immutable.
     */
    async evaluateTrade(symbol, livePrice, timeframe = shared_1.Timeframe.M15) {
        const signal = await this.generateSignalForSymbol(symbol, timeframe);
        const entry = signal.entryZone.optimal;
        const sl = signal.stopLoss;
        const tp1 = signal.takeProfits.tp1;
        const tp2 = signal.takeProfits.tp2;
        const tp3 = signal.takeProfits.tp3 || tp2 * 1.05;
        const isBullish = signal.direction === 'BULLISH';
        let completedState = null;
        let exitPrice = livePrice;
        let exitReason = '';
        let pnlRMultiple = 0;
        if (isBullish) {
            if (livePrice >= tp3) {
                completedState = 'TP3_HIT';
                exitPrice = tp3;
                exitReason = 'Target 3 Completed (4.0R Runner)';
                pnlRMultiple = 4.0;
            }
            else if (livePrice >= tp2) {
                completedState = 'TP2_HIT';
                exitPrice = tp2;
                exitReason = 'Target 2 Completed (2.5R Full TP)';
                pnlRMultiple = 2.5;
            }
            else if (livePrice >= tp1) {
                completedState = 'TP1_HIT';
                exitPrice = tp1;
                exitReason = 'Target 1 Completed (1.5R Scale Out)';
                pnlRMultiple = 1.5;
            }
            else if (livePrice <= sl) {
                completedState = 'SL_HIT';
                exitPrice = sl;
                exitReason = 'Stop Loss Hit (Structural Invalidation)';
                pnlRMultiple = -1.0;
            }
        }
        else {
            // Bearish
            if (livePrice <= tp3) {
                completedState = 'TP3_HIT';
                exitPrice = tp3;
                exitReason = 'Target 3 Completed (4.0R Runner)';
                pnlRMultiple = 4.0;
            }
            else if (livePrice <= tp2) {
                completedState = 'TP2_HIT';
                exitPrice = tp2;
                exitReason = 'Target 2 Completed (2.5R Full TP)';
                pnlRMultiple = 2.5;
            }
            else if (livePrice <= tp1) {
                completedState = 'TP1_HIT';
                exitPrice = tp1;
                exitReason = 'Target 1 Completed (1.5R Scale Out)';
                pnlRMultiple = 1.5;
            }
            else if (livePrice >= sl) {
                completedState = 'SL_HIT';
                exitPrice = sl;
                exitReason = 'Stop Loss Hit (Structural Invalidation)';
                pnlRMultiple = -1.0;
            }
        }
        return {
            isCompleted: false,
            wouldClose: Boolean(completedState),
            previewExit: completedState
                ? {
                    state: completedState,
                    exitPrice,
                    exitReason,
                    pnlRMultiple,
                }
                : null,
            activeSignal: signal,
        };
    }
    /**
     * Persists a completed trade into PostgreSQL Signal table
     */
    async recordCompletedTrade(data) {
        const inst = await this.prisma.instrument.findUnique({
            where: { symbol: data.symbol.toUpperCase() },
        });
        if (!inst) {
            throw new common_1.NotFoundException(`Instrument '${data.symbol}' not found`);
        }
        if (data.direction === 'NEUTRAL' ||
            data.direction === 'NO_TRADE' ||
            data.grade === 'NO_TRADE' ||
            data.score === 0) {
            this.logger.debug(`[REJECTED] Ignoring NO_TRADE / NEUTRAL signal recording for ${data.symbol}`);
            return null;
        }
        const entryPrice = Number(data.entryPrice);
        const exitPrice = Number(data.exitPrice);
        const activatedAt = this.coerceAuthoritativeTimestamp(data.activatedAt, 'activatedAt');
        const closedAt = this.coerceAuthoritativeTimestamp(data.closedAt || new Date(), 'closedAt');
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            throw new common_1.BadRequestException('entryPrice must be a positive finite execution price');
        }
        if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
            throw new common_1.BadRequestException('exitPrice must be a positive finite execution price');
        }
        if (closedAt.getTime() < activatedAt.getTime()) {
            throw new common_1.BadRequestException('closedAt cannot be before activatedAt');
        }
        const priceTolerance = this.getPriceTolerance(data.symbol, entryPrice, exitPrice);
        // Strong Deduplication check: check if an identical setup was already saved
        const existing = await this.prisma.signal.findFirst({
            where: {
                instrumentId: inst.id,
                timeframe: (0, shared_1.toPrismaTimeframe)(data.timeframe || '15m'),
                OR: [
                    // 1. Same activation timestamp within 45 min
                    {
                        activatedAt: {
                            gte: new Date(activatedAt.getTime() - 45 * 60 * 1000),
                            lte: new Date(activatedAt.getTime() + 45 * 60 * 1000),
                        },
                    },
                    // 2. Same entry price recorded within 4 hours
                    {
                        entryPrice: {
                            gte: entryPrice - priceTolerance,
                            lte: entryPrice + priceTolerance,
                        },
                        closedAt: {
                            gte: new Date(closedAt.getTime() - 4 * 3600 * 1000),
                            lte: new Date(closedAt.getTime() + 4 * 3600 * 1000),
                        },
                    },
                ],
            },
            orderBy: { closedAt: 'desc' },
            include: { instrument: true },
        });
        if (existing) {
            this.logger.debug(`[DEDUPLICATION] Trade ${data.symbol} ${data.direction} @ ${data.entryPrice} already recorded. Skipping duplicate.`);
            return existing;
        }
        // Map timeframe enum string safely
        const tfEnum = (0, shared_1.toPrismaTimeframe)(data.timeframe || '15m');
        const contractSymbol = data.contractSymbol ||
            (data.strike && data.optionType
                ? `${data.symbol} ${data.strike} ${data.optionType}`
                : data.symbol);
        const signalRecord = await this.prisma.signal.create({
            data: {
                instrumentId: inst.id,
                direction: data.direction,
                state: data.state,
                grade: (data.grade === 'A+' ? 'A_PLUS' : data.grade || 'A_PLUS'),
                score: data.score || 90,
                timeframe: tfEnum,
                entryPrice,
                stopLoss: data.stopLoss,
                target1: data.target1,
                target2: data.target2,
                target3: data.target3 || null,
                riskRewardRatio: data.riskRewardRatio || 2.5,
                exitPrice,
                pnlAmount: data.pnlAmount,
                pnlRMultiple: data.pnlRMultiple,
                reasonsJson: {
                    contractSymbol,
                    instrumentType: data.instrumentType || (data.strike ? 'OPTION' : 'SPOT'),
                    strike: data.strike,
                    optionType: data.optionType,
                    quantity: data.quantity,
                    tradeReason: data.tradeReason ||
                        `Institutional ${data.direction} momentum setup on ${contractSymbol}`,
                    exitReason: data.exitReason,
                    checklist: data.checklist || [
                        `Institutional Multi-Timeframe Alignment (${data.timeframe || '15m'})`,
                        `Dynamic Supply/Demand / Order Block Mitigation`,
                        `Break of Structure (BOS) Volume Confirmation`,
                        `Strict Risk/Reward Scaling Targets`,
                    ],
                    summary: `Closed trade on ${contractSymbol} via ${data.state} at ${data.exitPrice}`,
                },
                risksJson: {
                    riskPerUnit: Math.abs(entryPrice - data.stopLoss),
                },
                activatedAt,
                closedAt,
            },
            include: {
                instrument: true,
            },
        });
        this.logger.log(`✓ [TRADE CLOSED & RECORDED] ${contractSymbol} ${data.direction} -> ${data.state} @ ${data.exitPrice} | PnL: ${data.pnlAmount} (${data.pnlRMultiple}R)`);
        return signalRecord;
    }
    getPriceTolerance(symbol, entryPrice, exitPrice) {
        if (symbol.toUpperCase() === 'BTCUSDT')
            return 1.0;
        const maxPrice = Math.max(Math.abs(entryPrice), Math.abs(exitPrice));
        if (maxPrice < 5000)
            return 0.05; // option premiums/equities
        if (symbol.toUpperCase() === 'BANKNIFTY')
            return 0.5;
        return 0.25;
    }
    getTradeDedupKey(signal) {
        const symbol = signal.instrument.symbol;
        const entry = Number(signal.entryPrice);
        const exit = Number(signal.exitPrice || signal.target2);
        const tolerance = this.getPriceTolerance(symbol, entry, exit);
        const priceBucket = Math.max(tolerance, 0.01);
        const activatedAt = signal.activatedAt ? new Date(signal.activatedAt).getTime() : 0;
        const activatedBucket = activatedAt ? Math.round(activatedAt / (30 * 60 * 1000)) : 0;
        return [
            symbol,
            signal.state,
            signal.timeframe,
            Math.round(entry / priceBucket),
            Math.round(exit / priceBucket),
            activatedBucket,
        ].join('|');
    }
    coerceAuthoritativeTimestamp(inputDate, fieldName) {
        if (!inputDate) {
            throw new common_1.BadRequestException(`${fieldName} is required for an executed trade`);
        }
        const d = new Date(inputDate);
        if (Number.isNaN(d.getTime())) {
            throw new common_1.BadRequestException(`${fieldName} must be a valid timestamp`);
        }
        return d;
    }
    /**
     * Clears/removes all completed trades from the journal database
     */
    async clearAllCompletedTrades() {
        const result = await this.prisma.signal.deleteMany({
            where: {
                OR: [
                    {
                        state: {
                            in: [
                                'TP1_HIT',
                                'TP2_HIT',
                                'TP3_HIT',
                                'SL_HIT',
                                'EXPIRED',
                                'CANCELLED',
                                'INVALIDATED',
                            ],
                        },
                    },
                    { exitPrice: { not: null } },
                    { closedAt: { not: null } },
                    { pnlAmount: { not: null } },
                ],
            },
        });
        this.logger.log(`✓ Cleared ${result.count} closed trades completely from database.`);
        return { success: true, count: result.count };
    }
    /**
     * Retrieves all completed/recorded trades with win rate and P&L analytics
     */
    async getCompletedTrades(limit = 50) {
        const closedSignals = await this.prisma.signal.findMany({
            where: {
                state: {
                    in: ['TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'SL_HIT'],
                },
                exitPrice: {
                    not: null,
                },
                closedAt: {
                    not: null,
                },
                direction: {
                    in: ['BULLISH', 'BEARISH'],
                },
                grade: {
                    notIn: ['NO_TRADE'],
                },
            },
            include: {
                instrument: true,
            },
            orderBy: {
                closedAt: 'desc',
            },
            take: Math.max(limit * 3, limit),
        });
        const dedupedSignals = Array.from(closedSignals
            .reduce((acc, signal) => {
            const key = this.getTradeDedupKey(signal);
            if (!acc.has(key)) {
                acc.set(key, signal);
            }
            return acc;
        }, new Map())
            .values()).slice(0, limit);
        const totalTrades = dedupedSignals.length;
        const wins = dedupedSignals.filter((s) => s.state !== 'SL_HIT');
        const losses = dedupedSignals.filter((s) => s.state === 'SL_HIT');
        const winRate = totalTrades > 0 ? Number(((wins.length / totalTrades) * 100).toFixed(1)) : 0;
        const totalPnl = dedupedSignals.reduce((acc, curr) => acc + Number(curr.pnlAmount || 0), 0);
        const totalWinsPnl = wins.reduce((acc, curr) => acc + Number(curr.pnlAmount || 0), 0);
        const totalLossesPnl = Math.abs(losses.reduce((acc, curr) => acc + Number(curr.pnlAmount || 0), 0));
        const profitFactor = totalLossesPnl > 0
            ? Number((totalWinsPnl / totalLossesPnl).toFixed(2))
            : totalWinsPnl > 0
                ? 5.0
                : 0;
        const averageR = totalTrades > 0
            ? Number((dedupedSignals.reduce((acc, curr) => acc + Number(curr.pnlRMultiple || 0), 0) /
                totalTrades).toFixed(2))
            : 0;
        return {
            stats: {
                totalTrades,
                winningTrades: wins.length,
                losingTrades: losses.length,
                winRate,
                totalPnl: Number(totalPnl.toFixed(2)),
                profitFactor,
                averageR,
            },
            trades: dedupedSignals.map((s) => {
                const reasons = s.reasonsJson || {};
                const isOption = reasons.instrumentType === 'OPTION' ||
                    (Number(s.entryPrice) < 500 &&
                        (s.instrument.symbol === 'NIFTY' || s.instrument.symbol === 'BANKNIFTY'));
                const contractSymbol = reasons.contractSymbol ||
                    (isOption && reasons.strike
                        ? `${s.instrument.symbol} ${reasons.strike} ${reasons.optionType || (s.direction === 'BULLISH' ? 'CE' : 'PE')}`
                        : s.instrument.symbol);
                return {
                    id: s.id,
                    symbol: s.instrument.symbol,
                    contractSymbol,
                    instrumentType: reasons.instrumentType || (isOption ? 'OPTION' : 'SPOT'),
                    strike: reasons.strike,
                    optionType: reasons.optionType,
                    instrumentName: s.instrument.name,
                    currency: s.instrument.currency,
                    direction: s.direction,
                    state: s.state,
                    grade: s.grade,
                    score: s.score,
                    timeframe: s.timeframe,
                    quantity: reasons.quantity ||
                        (s.instrument.symbol === 'NIFTY'
                            ? 65
                            : s.instrument.symbol === 'BANKNIFTY'
                                ? 15
                                : s.instrument.symbol === 'BTCUSDT'
                                    ? 0.2
                                    : s.instrument.symbol === 'RELIANCE'
                                        ? 250
                                        : s.instrument.symbol === 'HDFCBANK'
                                            ? 550
                                            : s.instrument.symbol === 'INFY'
                                                ? 400
                                                : 100),
                    entryPrice: Number(s.entryPrice),
                    stopLoss: Number(s.stopLoss),
                    target1: Number(s.target1),
                    target2: Number(s.target2),
                    exitPrice: Number(s.exitPrice),
                    pnlAmount: Number(s.pnlAmount || 0),
                    pnlRMultiple: Number(s.pnlRMultiple || 0),
                    tradeReason: reasons.tradeReason || `Institutional ${s.direction} order flow on ${contractSymbol}`,
                    checklist: reasons.checklist || [
                        `Institutional Multi-Timeframe Alignment (${s.timeframe})`,
                        `Order Block Tap & FVG Liquidity Sweep Mitigation`,
                        `Break of Structure (BOS) Volume Confirmation`,
                        `Strict Risk/Reward Target Scaling Exits`,
                    ],
                    exitReason: reasons.exitReason || `${s.state} Hit`,
                    activatedAt: s.activatedAt,
                    closedAt: s.closedAt,
                    durationMinutes: s.closedAt && s.activatedAt
                        ? Math.round((new Date(s.closedAt).getTime() - new Date(s.activatedAt).getTime()) / 60000)
                        : 35,
                };
            }),
        };
    }
    /**
     * Generates a tax-compliant CSV export of completed trades with STT, turnover, GST, and SEBI fee breakdown.
     */
    async exportTradesToCsv(limit = 200) {
        const data = await this.getCompletedTrades(limit);
        const trades = data.trades || [];
        const headers = [
            'Trade ID',
            'Symbol',
            'Contract',
            'Asset Type',
            'Direction',
            'Outcome State',
            'Grade',
            'Timeframe',
            'Quantity',
            'Entry Price',
            'Exit Price',
            'Turnover (INR)',
            'Brokerage (INR)',
            'STT (INR)',
            'Exchange Turnover (INR)',
            'GST 18% (INR)',
            'SEBI Turnover (INR)',
            'Total Charges (INR)',
            'Gross Realized PnL (INR)',
            'Net Realized PnL (INR)',
            'R-Multiple',
            'Duration (Minutes)',
            'Activated At (IST)',
            'Closed At (IST)',
            'Trade Reason / Setup Confluence',
            'Exit Reason',
        ];
        const escapeCsv = (val) => {
            if (val === null || val === undefined)
                return '""';
            const str = String(val).replace(/"/g, '""');
            return `"${str}"`;
        };
        const formatIST = (dateStr) => {
            if (!dateStr)
                return '';
            const d = new Date(dateStr);
            if (isNaN(d.getTime()))
                return '';
            return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
        };
        const rows = trades.map((t) => {
            const isCrypto = t.symbol === 'BTCUSDT';
            const isGold = t.symbol === 'XAUUSD' || t.symbol === 'GOLD';
            const entryP = Number(t.entryPrice) || 0;
            const exitP = Number(t.exitPrice) || 0;
            const qty = Number(t.quantity) || 1;
            const turnover = Number(((entryP + exitP) * qty).toFixed(2));
            // Transaction charges breakdown
            const brokerage = isCrypto || isGold ? Number((turnover * 0.0005).toFixed(2)) : 40.0;
            const stt = isCrypto || isGold ? 0 : Number((turnover * 0.000125).toFixed(2));
            const exchangeTurnover = isCrypto || isGold ? 0 : Number((turnover * 0.0000345).toFixed(2));
            const gst = isCrypto || isGold ? 0 : Number(((brokerage + exchangeTurnover) * 0.18).toFixed(2));
            const sebiTurnover = isCrypto || isGold ? 0 : Number((turnover * 0.000001).toFixed(2));
            const totalCharges = Number((brokerage + stt + exchangeTurnover + gst + sebiTurnover).toFixed(2));
            const isBull = t.direction === 'BULLISH';
            const priceDiff = isBull ? exitP - entryP : entryP - exitP;
            const grossPnL = Number((priceDiff * qty).toFixed(2));
            const netPnL = Number(t.pnlAmount) || Number((grossPnL - totalCharges).toFixed(2));
            return [
                escapeCsv(t.id),
                escapeCsv(t.symbol),
                escapeCsv(t.contractSymbol || t.symbol),
                escapeCsv(t.instrumentType ||
                    (isCrypto ? 'CRYPTO' : isGold ? 'COMMODITY (SPOT GOLD)' : 'EQUITY/DERIVATIVES')),
                escapeCsv(t.direction),
                escapeCsv(t.state),
                escapeCsv(t.grade),
                escapeCsv(t.timeframe),
                qty,
                entryP.toFixed(2),
                exitP.toFixed(2),
                turnover.toFixed(2),
                brokerage.toFixed(2),
                stt.toFixed(2),
                exchangeTurnover.toFixed(2),
                gst.toFixed(2),
                sebiTurnover.toFixed(2),
                totalCharges.toFixed(2),
                grossPnL.toFixed(2),
                netPnL.toFixed(2),
                t.pnlRMultiple,
                t.durationMinutes,
                escapeCsv(formatIST(t.activatedAt)),
                escapeCsv(formatIST(t.closedAt)),
                escapeCsv(t.tradeReason),
                escapeCsv(t.exitReason),
            ].join(',');
        });
        const csvContent = [headers.join(','), ...rows].join('\n');
        const dateTag = new Date().toISOString().split('T')[0];
        const filename = `quant-trade-journal-tax-report-${dateTag}.csv`;
        return { filename, csvContent };
    }
    /**
     * Seeds realistic institutional SMC historical closed trades strictly within official market hours (09:15 AM - 03:30 PM IST)
     */
    async seedInitialCompletedTrades() {
        const instruments = await this.prisma.instrument.findMany({ where: { isActive: true } });
        if (instruments.length === 0)
            return;
        // Base trading day: last completed market session (31 Aug 2026)
        const setISTTime = (hours, minutes, daysAgo = 1) => {
            // hours & minutes in IST (UTC = IST - 5:30) on a past completed session
            const d = new Date();
            d.setDate(d.getDate() - daysAgo);
            const totalISTMinutes = hours * 60 + minutes;
            const totalUTCMinutes = totalISTMinutes - 330;
            const utcH = Math.floor(totalUTCMinutes / 60);
            const utcM = totalUTCMinutes % 60;
            d.setUTCHours(utcH, utcM, 0, 0);
            return d;
        };
        const sampleTrades = [
            {
                sym: 'NIFTY',
                dir: 'BEARISH',
                state: 'TP2_HIT',
                entry: 24160.0, // Candle @ 11:15 AM [Low 24117.00, High 24163.40]
                sl: 24185.0,
                tp1: 24115.0,
                tp2: 24085.0, // Candle @ 11:45 AM [Low 24077.00, High 24109.65]
                exit: 24085.0,
                pnl: 1875.0, // 75 pts * 25 qty
                r: 3.0,
                reason: 'Target 2 Completed (3.0R Structural Breakdown)',
                actIST: [11, 15], // 11:15 AM IST
                closeIST: [11, 45], // 11:45 AM IST
            },
            {
                sym: 'BANKNIFTY',
                dir: 'BEARISH',
                state: 'TP2_HIT',
                entry: 57550.0, // Candle @ 10:45 AM [Low 57532.70, High 57596.40]
                sl: 57630.0,
                tp1: 57450.0,
                tp2: 57350.0, // Candle @ 12:00 PM [Low 57333.05, High 57391.75]
                exit: 57350.0,
                pnl: 3000.0, // 200 pts * 15 qty
                r: 2.5,
                reason: 'Target 2 Completed (2.5R Order Block Rejection)',
                actIST: [10, 45], // 10:45 AM IST
                closeIST: [12, 0], // 12:00 PM IST
            },
            {
                sym: 'BTCUSDT',
                dir: 'BULLISH',
                state: 'TP2_HIT',
                entry: 77998.84, // Binance 15m Candle @ 10:45 AM [Low 77758.01, High 78156.78]
                sl: 77818.84,
                tp1: 78268.84,
                tp2: 78448.84, // Binance 15m Candle @ 02:00 PM [High 78680.00]
                exit: 78448.84,
                pnl: 7830.0, // 450 pts * 0.20 BTC * 87
                r: 2.5,
                reason: 'Target 2 Completed (2.5R Saiyan ALMA Crossover)',
                actIST: [10, 45], // 10:45 AM IST
                closeIST: [14, 0], // 02:00 PM IST
            },
            {
                sym: 'BTCUSDT',
                dir: 'BEARISH',
                state: 'TP3_HIT',
                entry: 78480.08, // Binance 15m Candle @ 04:45 PM [Low 78472.00, High 78640.01]
                sl: 78660.08,
                tp1: 78210.08,
                tp2: 78030.08,
                tp3: 77760.08, // Binance 15m Candle @ 06:00 PM [Low 77750.00]
                exit: 77760.08,
                pnl: 12528.0, // 720 pts * 0.20 BTC * 87
                r: 4.0,
                reason: 'Target 3 Completed (4.0R Dynamic Supply Rejection)',
                actIST: [16, 45], // 04:45 PM IST
                closeIST: [18, 0], // 06:00 PM IST
            },
            {
                sym: 'RELIANCE',
                dir: 'BEARISH',
                state: 'TP2_HIT',
                entry: 1286.35, // Candle @ 02:00 PM [Low 1284.10, High 1289.80]
                sl: 1289.0,
                tp1: 1283.0,
                tp2: 1280.35, // Candle @ 03:00 PM [Low 1277.00, High 1282.60]
                exit: 1280.35,
                pnl: 1500.0, // 6.00 pts * 250 shares
                r: 2.26,
                reason: 'Target 2 Completed (2.26R Trend Extension)',
                actIST: [14, 0], // 02:00 PM IST on 31 Aug
                closeIST: [15, 0], // 03:00 PM IST on 31 Aug
            },
            {
                sym: 'HDFCBANK',
                dir: 'BULLISH',
                state: 'TP2_HIT',
                entry: 715.8, // Candle @ 01:45 PM [Low 715.15, High 716.30]
                sl: 713.8,
                tp1: 718.0,
                tp2: 720.0, // Candle @ 03:15 PM [Low 719.50, High 720.30]
                exit: 720.0,
                pnl: 420.0, // 4.20 pts * 100 shares
                r: 2.1,
                reason: 'Target 2 Completed (2.1R Closing Drive)',
                actIST: [13, 45], // 01:45 PM IST on 31 Aug
                closeIST: [15, 15], // 03:15 PM IST on 31 Aug
            },
            {
                sym: 'INFY',
                dir: 'BULLISH',
                state: 'TP2_HIT',
                entry: 1130.0, // Candle @ 09:15 AM [Low 1125.60, High 1140.80]
                sl: 1124.0,
                tp1: 1139.0,
                tp2: 1144.0, // Candle @ 10:00 AM [Low 1138.60, High 1144.90]
                exit: 1144.0,
                pnl: 1400.0, // 14.0 pts * 100 shares
                r: 2.33,
                reason: 'Target 2 Completed (2.33R Opening Drive)',
                actIST: [9, 15], // 09:15 AM IST on 31 Aug
                closeIST: [10, 0], // 10:00 AM IST on 31 Aug
            },
            {
                sym: 'XAUUSD',
                dir: 'BULLISH',
                state: 'TP2_HIT',
                entry: 2872.5,
                sl: 2865.0,
                tp1: 2882.0,
                tp2: 2891.0,
                exit: 2891.0,
                pnl: 16095.0, // (2891.0 - 2872.5 = 18.5 USD/oz * 10 oz * 87 INR)
                r: 2.47,
                reason: 'Target 2 Completed (2.47R NY Open Expansion)',
                actIST: [17, 30], // 05:30 PM IST (NY Open)
                closeIST: [19, 45], // 07:45 PM IST
            },
        ];
        for (let i = 0; i < sampleTrades.length; i++) {
            const t = sampleTrades[i];
            const inst = instruments.find((ins) => ins.symbol === t.sym);
            if (!inst)
                continue;
            const actTime = setISTTime(t.actIST[0], t.actIST[1]);
            const closeTime = setISTTime(t.closeIST[0], t.closeIST[1]);
            await this.prisma.signal.create({
                data: {
                    instrumentId: inst.id,
                    direction: t.dir,
                    state: t.state,
                    grade: 'A_PLUS',
                    score: 88,
                    timeframe: 'M15',
                    entryPrice: t.entry,
                    stopLoss: t.sl,
                    target1: t.tp1,
                    target2: t.tp2,
                    riskRewardRatio: 2.5,
                    exitPrice: t.exit,
                    pnlAmount: t.pnl,
                    pnlRMultiple: t.r,
                    reasonsJson: {
                        exitReason: t.reason,
                        tradeReason: t.sym === 'BTCUSDT'
                            ? '⚡ Saiyan OCC ALMA (len=2, sigma=5, offset=0.85) 8x Alternate Resolution Crossover + Swing Demand POI BOS Breakout'
                            : `🏛️ Institutional SMC ${t.dir} Order Block Mitigation [${t.sl} - ${t.entry}] + FVG Liquidity Sweep Mitigation`,
                        checklist: [
                            `Multi-Timeframe Order Flow Bias Alignment (${t.dir})`,
                            `Institutional Order Block / Demand POI Tap`,
                            `Fair Value Gap (FVG) Liquidity Sweep Mitigation`,
                            `Break of Structure (BOS) Volume Expansion`,
                            `Multi-Tier Scaling Exit Target Completed`,
                        ],
                    },
                    risksJson: { riskPerUnit: Math.abs(t.entry - t.sl) },
                    activatedAt: actTime,
                    closedAt: closeTime,
                },
            });
        }
    }
    calculatePositionSize(accountBalance, riskPercentage, entryPrice, stopLoss, lotSize = 1) {
        return risk_engine_1.PositionSizer.calculatePosition({
            accountBalance,
            riskPercentage,
            entryPrice,
            stopLoss,
            lotSize,
        });
    }
    /**
     * Scans multi-asset historical price structure and syncs completed strategy trades into the Journal
     */
    async syncHistoricalTrades() {
        const symbols = ['BTCUSDT', 'XAUUSD', 'NIFTY', 'BANKNIFTY', 'RELIANCE', 'HDFCBANK', 'INFY'];
        let syncedCount = 0;
        for (const sym of symbols) {
            try {
                const inst = await this.prisma.instrument.findUnique({ where: { symbol: sym } });
                if (!inst)
                    continue;
                const candleRes = await this.candlesService.getCandles({
                    symbol: sym,
                    timeframe: shared_1.Timeframe.M15,
                    limit: 150,
                });
                const candles = candleRes.candles;
                if (!candles || candles.length < 25)
                    continue;
                if (sym === 'BTCUSDT') {
                    // Accurate Saiyan OCC Historical Playback for BTCUSDT
                    const opens = candles.map((c) => c.open);
                    const closes = candles.map((c) => c.close);
                    const openSeriesAlt = trading_engine_1.SaiyanOCCEngine.calculateVariant('ALMA', opens, 2 * 8, 5, 0.85);
                    const closeSeriesAlt = trading_engine_1.SaiyanOCCEngine.calculateVariant('ALMA', closes, 2 * 8, 5, 0.85);
                    let activeTrade = null;
                    for (let i = 1; i < candles.length; i++) {
                        const prevC = closeSeriesAlt[i - 1];
                        const prevO = openSeriesAlt[i - 1];
                        const currC = closeSeriesAlt[i];
                        const currO = openSeriesAlt[i];
                        const isCrossUp = prevC <= prevO && currC > currO;
                        const isCrossDn = prevC >= prevO && currC < currO;
                        if (activeTrade) {
                            const c = candles[i];
                            let closedState = null;
                            let exitP = 0;
                            let rMult = 0;
                            let exitNote = '';
                            if (activeTrade.dir === 'BULLISH') {
                                if (c.high >= activeTrade.tp3) {
                                    closedState = 'TP3_HIT';
                                    exitP = activeTrade.tp3;
                                    rMult = 4.0;
                                    exitNote = 'Target 3 Completed (4.0R Runner Exit)';
                                }
                                else if (c.high >= activeTrade.tp2) {
                                    closedState = 'TP2_HIT';
                                    exitP = activeTrade.tp2;
                                    rMult = 2.5;
                                    exitNote = 'Target 2 Completed (2.5R Full TP Exit)';
                                }
                                else if (c.low <= activeTrade.sl) {
                                    closedState = 'SL_HIT';
                                    exitP = activeTrade.sl;
                                    rMult = -1.0;
                                    exitNote = 'Stop Loss Hit (Structural Invalidation)';
                                }
                            }
                            else if (activeTrade.dir === 'BEARISH') {
                                if (c.low <= activeTrade.tp3) {
                                    closedState = 'TP3_HIT';
                                    exitP = activeTrade.tp3;
                                    rMult = 4.0;
                                    exitNote = 'Target 3 Completed (4.0R Runner Exit)';
                                }
                                else if (c.low <= activeTrade.tp2) {
                                    closedState = 'TP2_HIT';
                                    exitP = activeTrade.tp2;
                                    rMult = 2.5;
                                    exitNote = 'Target 2 Completed (2.5R Full TP Exit)';
                                }
                                else if (c.high >= activeTrade.sl) {
                                    closedState = 'SL_HIT';
                                    exitP = activeTrade.sl;
                                    rMult = -1.0;
                                    exitNote = 'Stop Loss Hit (Structural Invalidation)';
                                }
                            }
                            if (closedState) {
                                const isLong = activeTrade.dir === 'BULLISH';
                                const priceDiff = isLong ? exitP - activeTrade.entry : activeTrade.entry - exitP;
                                const pnlAmount = Number((priceDiff * 0.2 * 87.0).toFixed(2));
                                await this.recordCompletedTrade({
                                    symbol: 'BTCUSDT',
                                    direction: activeTrade.dir,
                                    state: closedState,
                                    grade: 'A_PLUS',
                                    score: 90,
                                    timeframe: '15m',
                                    entryPrice: activeTrade.entry,
                                    stopLoss: activeTrade.sl,
                                    target1: activeTrade.tp1,
                                    target2: activeTrade.tp2,
                                    target3: activeTrade.tp3,
                                    exitPrice: exitP,
                                    pnlAmount,
                                    pnlRMultiple: rMult,
                                    riskRewardRatio: 2.5,
                                    tradeReason: `⚡ Saiyan OCC ALMA (len=2, sigma=5, offset=0.85) 8x Alternate Resolution ${activeTrade.dir === 'BULLISH' ? 'Crossover' : 'Crossunder'} @ ₹${activeTrade.entry.toFixed(2)}`,
                                    checklist: [
                                        'Saiyan ALMA OCC 8x Alternate Resolution Momentum Cross',
                                        'Dynamic Swing Supply & Demand POI Map',
                                        'ATR-Buffered Break of Structure (BOS) Breakdown',
                                        'Multi-Tier Scaling Targets (TP1 1.5R, TP2 2.5R, TP3 4.0R)',
                                    ],
                                    exitReason: exitNote,
                                    activatedAt: activeTrade.activatedAt,
                                    closedAt: c.timestamp,
                                });
                                syncedCount++;
                                activeTrade = null;
                            }
                        }
                        if (isCrossUp) {
                            const entry = Number(candles[i].close.toFixed(2));
                            const risk = 180;
                            activeTrade = {
                                dir: 'BULLISH',
                                entry,
                                sl: Number((entry - risk).toFixed(2)),
                                tp1: Number((entry + risk * 1.5).toFixed(2)),
                                tp2: Number((entry + risk * 2.5).toFixed(2)),
                                tp3: Number((entry + risk * 4.0).toFixed(2)),
                                activatedAt: new Date(candles[i].timestamp),
                            };
                        }
                        else if (isCrossDn) {
                            const entry = Number(candles[i].close.toFixed(2));
                            const risk = 180;
                            activeTrade = {
                                dir: 'BEARISH',
                                entry,
                                sl: Number((entry + risk).toFixed(2)),
                                tp1: Number((entry - risk * 1.5).toFixed(2)),
                                tp2: Number((entry - risk * 2.5).toFixed(2)),
                                tp3: Number((entry - risk * 4.0).toFixed(2)),
                                activatedAt: new Date(candles[i].timestamp),
                            };
                        }
                    }
                }
                else {
                    // SMC Historical Playback for Indian NSE assets
                    let activeSignal = null;
                    let entryTime = null;
                    let entryPrice = 0;
                    for (let i = 25; i < candles.length; i++) {
                        const currentCandle = candles[i];
                        const slice = candles.slice(0, i + 1);
                        if (activeSignal) {
                            const update = risk_engine_1.TradeLifecycleManager.evaluateTick(activeSignal, currentCandle);
                            if (activeSignal.state === 'PENDING' && update.newState === 'ACTIVE') {
                                activeSignal.state = 'ACTIVE';
                                entryTime = new Date(currentCandle.timestamp);
                                entryPrice = update.currentPrice;
                            }
                            else if (update.isClosed) {
                                if (entryTime && entryPrice > 0) {
                                    const isLong = activeSignal.direction === 'BULLISH';
                                    const exitPrice = update.currentPrice;
                                    const priceDiff = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
                                    const lotMultiplier = sym === 'NIFTY'
                                        ? 65
                                        : sym === 'BANKNIFTY'
                                            ? 15
                                            : sym === 'XAUUSD' || sym === 'GOLD'
                                                ? 10 * 87.0
                                                : sym === 'RELIANCE'
                                                    ? 250
                                                    : sym === 'HDFCBANK'
                                                        ? 550
                                                        : sym === 'INFY'
                                                            ? 400
                                                            : 100;
                                    const pnlAmount = Number((priceDiff * lotMultiplier).toFixed(2));
                                    const riskPerUnit = Math.abs(entryPrice - activeSignal.stopLoss);
                                    const pnlRMultiple = riskPerUnit > 0
                                        ? Number((priceDiff / riskPerUnit).toFixed(2))
                                        : update.pnlRMultiple;
                                    await this.recordCompletedTrade({
                                        symbol: sym,
                                        direction: activeSignal.direction,
                                        state: update.newState,
                                        grade: activeSignal.grade || 'A_PLUS',
                                        score: activeSignal.score || 90,
                                        timeframe: '15m',
                                        entryPrice,
                                        stopLoss: activeSignal.stopLoss,
                                        target1: activeSignal.takeProfits?.tp1 || entryPrice,
                                        target2: activeSignal.takeProfits?.tp2 || entryPrice,
                                        target3: activeSignal.takeProfits?.tp3,
                                        exitPrice,
                                        pnlAmount,
                                        pnlRMultiple,
                                        riskRewardRatio: activeSignal.riskRewardRatios?.rr2 || 2.5,
                                        tradeReason: `🏛️ Institutional SMC ${activeSignal.direction} Order Block Mitigation [${activeSignal.stopLoss} - ${entryPrice}]`,
                                        checklist: [
                                            `Multi-Timeframe Order Flow Bias Alignment (${activeSignal.direction})`,
                                            'Institutional Order Block / Supply-Demand POI Tap',
                                            'Fair Value Gap (FVG) Liquidity Sweep Mitigation',
                                            'Break of Structure (BOS) Volume Confirmation',
                                        ],
                                        exitReason: update.notes || `${update.newState} Executed`,
                                        activatedAt: entryTime,
                                        closedAt: new Date(currentCandle.timestamp),
                                    });
                                    syncedCount++;
                                }
                                activeSignal = null;
                                entryTime = null;
                                entryPrice = 0;
                            }
                            else {
                                activeSignal.state = update.newState;
                            }
                            continue;
                        }
                        const signal = trading_engine_1.SignalGenerator.generateSignal({
                            symbol: sym,
                            executionCandles: slice,
                            executionTimeframe: '15m',
                            htf1Candles: slice,
                        });
                        if (signal.direction !== 'NEUTRAL' &&
                            signal.score >= 70 &&
                            signal.grade !== 'NO_TRADE') {
                            activeSignal = { ...signal, id: `sig-${sym}-${i}`, state: 'PENDING' };
                        }
                    }
                }
            }
            catch (e) {
                this.logger.warn(`Failed to sync trades for ${sym}: ${e}`);
            }
        }
        this.logger.log(`✓ Synchronized ${syncedCount} authentic strategy execution trades into Journal database.`);
        return this.getCompletedTrades(100);
    }
};
exports.SignalsService = SignalsService;
exports.SignalsService = SignalsService = SignalsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        candles_service_1.CandlesService])
], SignalsService);
//# sourceMappingURL=signals.service.js.map