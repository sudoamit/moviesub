import { FillModel, IFill, IOrder, OrderSide, SameCandleAmbiguityMode } from './types';
import { ICandle } from '@quant/shared';
export declare class FillModelEngine {
    /**
     * Authoritative deterministic timestamp extractor and validator for candles.
     * Accepts Date, numeric timestamps, and parseable date strings.
     * Throws an explicit Error for invalid, NaN, or non-finite values. Never uses Date.now().
     */
    static requireCandleTimestamp(candle: ICandle): number;
    /**
     * Validates lower timeframe sub-bars strictly against parent candle range and chronological ordering
     */
    static validateSubBars(parentCandle: ICandle, lowerTfCandles?: ICandle[], parentDurationMs?: number, allowPartial?: boolean): {
        isValid: boolean;
        reason?: string;
    };
    /**
     * Authoritative Segment-Aware Intra-Segment Conflict Resolver
     * For orders triggered within the SAME path segment (segStart -> segEnd), computes distance along vector:
     * distance = Math.abs(triggerPrice - segStart)
     * The order with the smallest distance was encountered FIRST along the segment vector!
     * Ambiguity policies (CONSERVATIVE / OPTIMISTIC) act ONLY as tie-breakers when distances are identical.
     */
    static resolveSegmentConflict(triggered: {
        order: IOrder;
        fill: IFill;
    }[], segStart: number, segEnd: number, ambiguityMode?: SameCandleAmbiguityMode): {
        winningFill?: IFill;
        winningOrder?: IOrder;
        reason?: string;
    };
    /**
     * Thin compatibility wrapper for Same-Candle Ambiguity Conflict Resolution.
     * Delegates evaluation directly to OHLCPathCursor, evaluateSegmentFill, and resolveSegmentConflict.
     */
    static resolveSameCandleConflict(orders: IOrder[], currentCandle: ICandle, nextCandle?: ICandle, model?: FillModel, ambiguityMode?: SameCandleAmbiguityMode, lowerTfCandles?: ICandle[], parentDurationMs?: number): {
        winningFill?: IFill;
        winningOrder?: IOrder;
        reason?: string;
    };
    /**
     * Helper to calculate gap-through base price for STOP orders
     */
    static calculateStopBasePrice(side: OrderSide, stopPrice: number, referencePrice: number): number;
    /**
     * Helper to calculate gap-through base price for LIMIT orders
     */
    static calculateLimitBasePrice(side: OrderSide, targetPrice: number, referencePrice: number): number;
    /**
     * Single source of truth for fill construction, slippage, spread, and fee calculations.
     */
    static buildFill(order: IOrder, basePrice: number, candleTime: number, symbol: string, orderType: 'MARKET' | 'LIMIT' | 'STOP', currentCandle?: ICandle, model?: FillModel): IFill;
    /**
     * Evaluates an order against a specific intra-candle segment (e.g. Open -> Low, Low -> High, High -> Close)
     */
    static evaluateSegmentFill(order: IOrder, segStart: number, segEnd: number, candleTime: number, symbol: string, model?: FillModel): {
        isFilled: boolean;
        fill?: IFill;
        reason?: string;
    };
    /**
     * Evaluates order against current candle using configured FillModel
     */
    static evaluateFill(order: IOrder, currentCandle: ICandle, nextCandle?: ICandle, model?: FillModel, lowerTfCandles?: ICandle[], parentDurationMs?: number): {
        isFilled: boolean;
        fill?: IFill;
        reason?: string;
    };
}
