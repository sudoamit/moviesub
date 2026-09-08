import { Direction, ICandle, IFairValueGap, IOrderBlock, ISwingPoint } from '@quant/shared';
export interface ITradeLevels {
    direction: Direction;
    entryZone: {
        min: number;
        max: number;
        optimal: number;
    };
    stopLoss: number;
    stopLossDistance: number;
    takeProfits: {
        tp1: number;
        tp2: number;
        tp3: number;
    };
    riskRewardRatios: {
        rr1: number;
        rr2: number;
        rr3: number;
    };
}
export declare class TradeLevelsCalculator {
    /**
     * Calculates ultra-precise execution entry zone, tight institutional invalidation stop loss (Sniper SL),
     * and high risk-to-reward asymmetric take profit targets (1:2.0 to 1:6.0+ R:R).
     */
    static calculateLevels(direction: Direction, candles: ICandle[], anchorSwing: ISwingPoint | null, orderBlock: IOrderBlock | null, fvg: IFairValueGap | null): ITradeLevels | null;
}
