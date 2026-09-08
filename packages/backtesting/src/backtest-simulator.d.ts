import { IBacktestOptions, IBacktestSimulationResult } from './types';
export declare class BacktestSimulator {
    private static getDurationMs;
    private static submitRestingExitOrders;
    /**
     * Simulates strategy historical execution candle-by-candle with zero look-ahead bias,
     * authoritative ExecutionSimulator order/fill pipeline, resting exit orders, gap handling,
     * fail-closed sizing, and bar-by-bar equity tracking.
     */
    static runSimulation(options: IBacktestOptions): IBacktestSimulationResult;
}
