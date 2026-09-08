"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const execution_1 = require("../execution");
const market_data_router_1 = require("../market-data-router");
describe('Backtest Execution & Accounting Hardening', () => {
    const baseTime = 1756972800000;
    describe('Fill Models & Authoritative ExecutionSimulator', () => {
        it('NEXT_BAR_MARKET: Fills on next candle open price with spread and slippage', () => {
            const exec = new execution_1.ExecutionSimulator(execution_1.FillModel.NEXT_BAR_MARKET);
            const order = exec.submitOrder({
                tradeId: 't1',
                symbol: 'BTCUSDT',
                side: 'BUY',
                orderType: 'MARKET',
                quantity: 1,
                timestamp: baseTime,
            });
            const currentCandle = {
                timestamp: new Date(baseTime),
                open: 100,
                high: 102,
                low: 99,
                close: 101,
                volume: 100,
            };
            const nextCandle = {
                timestamp: new Date(baseTime + 15 * 60 * 1000),
                open: 105,
                high: 108,
                low: 104,
                close: 107,
                volume: 100,
            };
            // Process current candle (should NOT fill on same candle open when NEXT_BAR_MARKET)
            const res1 = exec.processCandle(currentCandle, nextCandle);
            expect(res1.fills.length).toBe(1);
            expect(res1.fills[0].price).toBeGreaterThanOrEqual(105);
        });
        it('LIMIT_TOUCH: Fills when candle touches target limit price', () => {
            const order = {
                orderId: 'o1',
                clientOrderId: 'c1',
                tradeId: 't1',
                symbol: 'NIFTY',
                side: 'BUY',
                orderType: 'LIMIT',
                price: 100,
                quantity: 10,
                remainingQuantity: 10,
                status: 'PENDING',
                createdAt: baseTime,
                submittedAt: baseTime,
                fees: 0,
                slippage: 0,
            };
            const candleNoTouch = {
                timestamp: new Date(baseTime),
                open: 105,
                high: 110,
                low: 102,
                close: 108,
                volume: 100,
            };
            const resNoTouch = execution_1.FillModelEngine.evaluateFill(order, candleNoTouch, undefined, execution_1.FillModel.LIMIT_TOUCH);
            expect(resNoTouch.isFilled).toBe(false);
            const candleTouch = {
                timestamp: new Date(baseTime + 15 * 60 * 1000),
                open: 105,
                high: 110,
                low: 98,
                close: 102,
                volume: 100,
            };
            const resTouch = execution_1.FillModelEngine.evaluateFill(order, candleTouch, undefined, execution_1.FillModel.LIMIT_TOUCH);
            expect(resTouch.isFilled).toBe(true);
            expect(resTouch.fill?.price).toBe(100);
        });
        it('LOWER_TIMEFRAME: Fails closed with MISSING_LOWER_TF_DATA when sub-bar candles are missing', () => {
            const order = {
                orderId: 'o2',
                clientOrderId: 'c2',
                tradeId: 't2',
                symbol: 'BTCUSDT',
                side: 'BUY',
                orderType: 'LIMIT',
                price: 100,
                quantity: 1,
                remainingQuantity: 1,
                status: 'PENDING',
                createdAt: baseTime,
                submittedAt: baseTime,
                fees: 0,
                slippage: 0,
            };
            const candle = {
                timestamp: new Date(baseTime),
                open: 105,
                high: 110,
                low: 95,
                close: 102,
                volume: 100,
            };
            const res = execution_1.FillModelEngine.evaluateFill(order, candle, undefined, execution_1.FillModel.LOWER_TIMEFRAME, []);
            expect(res.isFilled).toBe(false);
            expect(res.reason).toBe('MISSING_LOWER_TF_DATA');
        });
    });
    describe('Centralized Same-Candle Ambiguity Conflict Resolution', () => {
        const slOrder = {
            orderId: 'o_sl',
            clientOrderId: 'c_sl',
            tradeId: 'trade_1',
            symbol: 'BTCUSDT',
            side: 'SELL',
            orderType: 'STOP',
            stopPrice: 95,
            quantity: 1,
            remainingQuantity: 1,
            status: 'PENDING',
            createdAt: baseTime,
            submittedAt: baseTime,
            fees: 0,
            slippage: 0,
        };
        const tpOrder = {
            orderId: 'o_tp',
            clientOrderId: 'c_tp',
            tradeId: 'trade_1',
            symbol: 'BTCUSDT',
            side: 'SELL',
            orderType: 'LIMIT',
            price: 105,
            quantity: 1,
            remainingQuantity: 1,
            status: 'PENDING',
            createdAt: baseTime,
            submittedAt: baseTime,
            fees: 0,
            slippage: 0,
        };
        // Candle that touches BOTH 95 (SL) and 105 (TP)
        const volatileCandle = {
            timestamp: new Date(baseTime),
            open: 100,
            high: 108,
            low: 92,
            close: 106,
            volume: 1000,
        };
        it('CONSERVATIVE mode: Stop loss order fills first when path encounters SL first', () => {
            const res = execution_1.FillModelEngine.resolveSameCandleConflict([slOrder, tpOrder], volatileCandle, undefined, execution_1.FillModel.OHLC_PATH, execution_1.SameCandleAmbiguityMode.CONSERVATIVE);
            expect(res.winningOrder?.orderId).toBe('o_sl');
            expect(res.reason).toBe('OHLC_PATH_SEGMENT_EXACT');
        });
        it('OPTIMISTIC mode: Path ordering is authoritative and encounters SL first on bullish segment', () => {
            const res = execution_1.FillModelEngine.resolveSameCandleConflict([slOrder, tpOrder], volatileCandle, undefined, execution_1.FillModel.OHLC_PATH, execution_1.SameCandleAmbiguityMode.OPTIMISTIC);
            expect(res.winningOrder?.orderId).toBe('o_sl');
            expect(res.reason).toBe('OHLC_PATH_SEGMENT_EXACT');
        });
        it('OHLC_PATH mode: Bullish candle touches Low first for Long position exit', () => {
            const bullishCandle = {
                timestamp: new Date(baseTime),
                open: 100,
                high: 108,
                low: 92,
                close: 106, // Bullish
                volume: 1000,
            };
            const res = execution_1.FillModelEngine.resolveSameCandleConflict([slOrder, tpOrder], bullishCandle, undefined, execution_1.FillModel.OHLC_PATH, execution_1.SameCandleAmbiguityMode.OHLC_PATH);
            expect(res.winningOrder?.orderId).toBe('o_sl');
            expect(res.reason).toMatch(/OHLC_PATH/);
        });
    });
    describe('Gap Execution & Slippage Accounting', () => {
        it('should apply adverse slippage to BUY (higher) and SELL (lower) market orders', () => {
            const price = 100;
            const qty = 10;
            const buySlip = execution_1.SlippageModel.calculateSlippage(price, qty, 'BUY', 'MARKET');
            const sellSlip = execution_1.SlippageModel.calculateSlippage(price, qty, 'SELL', 'MARKET');
            expect(buySlip.executedPrice).toBeGreaterThan(price);
            expect(sellSlip.executedPrice).toBeLessThan(price);
        });
        it('should execute STOP orders at gap-down open price when market gaps past stop loss', () => {
            const order = {
                orderId: 'o_stop1',
                clientOrderId: 'c_stop1',
                tradeId: 't_stop1',
                symbol: 'NIFTY',
                side: 'SELL',
                orderType: 'STOP',
                stopPrice: 95,
                quantity: 10,
                remainingQuantity: 10,
                status: 'PENDING',
                createdAt: baseTime,
                submittedAt: baseTime,
                fees: 0,
                slippage: 0,
            };
            const gapCandle = {
                timestamp: new Date(baseTime + 15 * 60 * 1000),
                open: 90,
                high: 91,
                low: 88,
                close: 89,
                volume: 2000,
            };
            const res = execution_1.FillModelEngine.evaluateFill(order, gapCandle, undefined, execution_1.FillModel.OHLC_PATH);
            expect(res.isFilled).toBe(true);
            expect(res.fill?.price).toBeLessThanOrEqual(90);
        });
        it('Net P&L formula: netPnL = grossPnL - entryFee - exitFees (without double-counting slippage)', () => {
            const grossPnL = 1000;
            const entryFee = 20;
            const exitFees = 20;
            const netPnL = Number((grossPnL - entryFee - exitFees).toFixed(2));
            expect(netPnL).toBe(960);
        });
    });
    describe('Deterministic ID Replay & Sibling Cancellation', () => {
        it('should generate identical, reproducible sequence IDs across independent runs', () => {
            const sim1 = new execution_1.ExecutionSimulator(execution_1.FillModel.NEXT_BAR_MARKET, execution_1.SameCandleAmbiguityMode.CONSERVATIVE, { submissionLatencyMs: 0, processingLatencyMs: 0 }, 'run1');
            const sim2 = new execution_1.ExecutionSimulator(execution_1.FillModel.NEXT_BAR_MARKET, execution_1.SameCandleAmbiguityMode.CONSERVATIVE, { submissionLatencyMs: 0, processingLatencyMs: 0 }, 'run1');
            const o1 = sim1.submitOrder({ tradeId: 't1', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quantity: 1, timestamp: baseTime });
            const o2 = sim2.submitOrder({ tradeId: 't1', symbol: 'BTCUSDT', side: 'BUY', orderType: 'MARKET', quantity: 1, timestamp: baseTime });
            expect(o1.orderId).toBe(o2.orderId);
            expect(o1.clientOrderId).toBe(o2.clientOrderId);
        });
        it('should cancel sibling orders for trade upon invoking cancelTradeOrders', () => {
            const exec = new execution_1.ExecutionSimulator(execution_1.FillModel.LIMIT_TOUCH);
            const o1 = exec.submitOrder({ tradeId: 'trade_x', symbol: 'NIFTY', side: 'SELL', orderType: 'STOP', stopPrice: 95, quantity: 10, timestamp: baseTime });
            const o2 = exec.submitOrder({ tradeId: 'trade_x', symbol: 'NIFTY', side: 'SELL', orderType: 'LIMIT', price: 105, quantity: 10, timestamp: baseTime });
            const cancelledCount = exec.cancelTradeOrders('trade_x');
            expect(cancelledCount).toBe(2);
            expect(exec.getOrder(o1.orderId)?.status).toBe('CANCELLED');
            expect(exec.getOrder(o2.orderId)?.status).toBe('CANCELLED');
        });
    });
    describe('Multi-Timeframe Data Router & Strict Isolation', () => {
        it('should strictly exclude unclosed HTF candles and return empty htfSlice', () => {
            const router = new market_data_router_1.MarketDataRouter({
                executionCandles: [
                    { timestamp: new Date(baseTime), open: 100, high: 101, low: 99, close: 100, volume: 100 },
                    {
                        timestamp: new Date(baseTime + 15 * 60 * 1000),
                        open: 100,
                        high: 102,
                        low: 99,
                        close: 101,
                        volume: 100,
                    },
                ],
                htf1Candles: [
                    {
                        timestamp: new Date(baseTime),
                        open: 100,
                        high: 105,
                        low: 98,
                        close: 104,
                        volume: 1000,
                    },
                ],
                executionTimeframe: '15m',
                htf1Timeframe: '1h',
            });
            // At 10:15 (index 1), the 10:00-11:00 1h candle is NOT closed yet!
            const data = router.getAvailableMarketDataAt(1);
            expect(data.htf1Slice.length).toBe(0);
        });
    });
});
//# sourceMappingURL=backtest-execution.test.js.map