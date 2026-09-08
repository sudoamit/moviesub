import { IDealingRange, ISwingPoint } from '@quant/shared';
export declare class DealingRangeEngine {
    /**
     * Calculates dealing range, 50% equilibrium, premium, and discount zones from confirmed anchor swings
     */
    static calculateDealingRange(swings: ISwingPoint[]): IDealingRange | null;
    /**
     * Classifies where a given price sits in the dealing range
     */
    static classifyPriceZone(price: number, range: IDealingRange): 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
}
