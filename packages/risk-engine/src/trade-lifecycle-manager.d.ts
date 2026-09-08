import { ICandle, ISignalSetup, SignalState } from '@quant/shared';
import { IExecutionEvent, IPartialExitPolicy, ITradeStateUpdate, PositionLot } from './types';
export declare const DEFAULT_PARTIAL_EXIT_POLICY: IPartialExitPolicy;
export declare class TradeLifecycleManager {
    /**
     * Validates partial exit ratios to guarantee exact 100% position allocation
     */
    static validatePartialExitPolicy(policy: IPartialExitPolicy): {
        isValid: boolean;
        reason?: string;
    };
    /**
     * Initializes an explicit, immutable PositionLot from an activated setup
     */
    static createPositionLot(signal: ISignalSetup, executionPrice: number, quantity: number, executionTime: number, orderId?: string, entryFee?: number, entrySlippage?: number): PositionLot;
    /**
     * @deprecated Synthetic lifecycle tick evaluation is disabled for backtesting.
     * Backtesting MUST use ExecutionSimulator and FillModelEngine directly for authoritative order execution.
     */
    static evaluateLotTick(lot: PositionLot, candle: ICandle, policy?: IPartialExitPolicy, candleTimestamp?: number, forBacktest?: boolean): {
        lot: PositionLot;
        events: IExecutionEvent[];
        isClosed: boolean;
        state: SignalState;
    };
    /**
     * Compatibility wrapper for signal evaluation against raw candles
     */
    static evaluateTick(signal: ISignalSetup, candle: ICandle): ITradeStateUpdate;
}
