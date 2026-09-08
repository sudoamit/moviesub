import { ISlippageConfig, OrderSide, OrderType } from './types';
import { ICandle } from '@quant/shared';
export declare const DEFAULT_SLIPPAGE_CONFIG: ISlippageConfig;
export declare class SlippageModel {
    /**
     * Calculates realistic market order execution slippage taking into account volatility and order size
     */
    static calculateSlippage(price: number, quantity: number, side: OrderSide, orderType: OrderType, candle?: ICandle, config?: ISlippageConfig): {
        executedPrice: number;
        slippageAmount: number;
        slippageBps: number;
    };
}
