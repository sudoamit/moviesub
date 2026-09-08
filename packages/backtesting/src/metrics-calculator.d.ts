import { IBacktestTrade } from '@quant/shared';
import { IEquityPoint, IEquitySnapshot, IQuantitativeMetrics } from './types';
import { PositionLot } from '@quant/risk-engine';
export declare class MetricsCalculator {
    /**
     * Computes comprehensive quantitative performance metrics according to institutional standards
     */
    static calculateMetrics(trades: IBacktestTrade[], initialCapital: number, equityCurve: IEquityPoint[], equitySnapshots?: IEquitySnapshot[], positionLots?: PositionLot[]): IQuantitativeMetrics;
}
