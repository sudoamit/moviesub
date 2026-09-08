import { IFeeConfig, OrderSide } from './types';
export declare class FeeModel {
    /**
     * Calculates comprehensive exchange transaction costs, brokerage, turnover, STT/CTT, and taxes
     */
    static calculateFees(symbol: string, executionPrice: number, quantity: number, side: OrderSide, isMaker?: boolean, customConfig?: IFeeConfig): number;
}
