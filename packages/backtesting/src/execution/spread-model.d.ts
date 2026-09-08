import { ISpreadConfig } from './types';
export declare const DEFAULT_SPREAD_CONFIG: ISpreadConfig;
export declare class SpreadModel {
    /**
     * Calculates realistic market bid-ask half-spread
     */
    static getHalfSpread(price: number, symbol: string, config?: ISpreadConfig): number;
}
