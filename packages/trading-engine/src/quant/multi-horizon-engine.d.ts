import { ICandle } from '@quant/shared';
import { HorizonState, MultiHorizonQuantState } from './quant-types';
export interface IMultiHorizonOptions {
    asOfTimestamp?: Date;
    executionTimeframe?: string;
    htfTimeframe?: string;
    macroTimeframe?: string;
}
export declare class MultiHorizonEngine {
    /**
     * Filters a horizon candle set down to only closed candles whose close time is <= asOfTimestamp.
     */
    static getClosedCandlesAsOf(candles: ICandle[], timeframe: string, asOfTimestamp?: Date): ICandle[];
    /**
     * Analyzes an individual horizon timeframe.
     */
    static analyzeHorizon(candles: ICandle[], tfName: string, asOfTimestamp?: Date): HorizonState;
    /**
     * Compiles multi-horizon alignment across Macro, HTF, and Execution.
     */
    static evaluateMultiHorizon(executionCandles: ICandle[], htfCandles?: ICandle[], macroCandles?: ICandle[], options?: IMultiHorizonOptions): MultiHorizonQuantState;
}
