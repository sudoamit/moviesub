import { Direction, IExecutionSafetyDecision, IFeatureVector17D, IMarketDataQualityResult, IPositionSizing, ISMCConfluenceSetup } from '@quant/shared';
import { IOpenPosition, IRiskConfig } from './types';
import { IDrawdownStatus } from './drawdown-guard';
export interface IExecutionSafetyGateParams {
    instrument: string;
    direction: Direction | 'LONG' | 'SHORT' | 'BULLISH' | 'BEARISH';
    mode: 'PAPER' | 'LIVE';
    marketDataQuality: IMarketDataQualityResult;
    smcSetup: ISMCConfluenceSetup;
    featureVector: IFeatureVector17D;
    modelState: {
        status: 'ACTIVE' | 'CANDIDATE' | 'ARCHIVED' | 'DISABLED';
        isDrifted?: boolean;
    };
    prediction: {
        rawProbability: number;
        calibratedProbability: number;
        expectedR: number;
    };
    positionSizing: IPositionSizing;
    accountEquity: number;
    openPositions: IOpenPosition[];
    drawdownStatus?: IDrawdownStatus;
    riskConfig?: IRiskConfig;
    minExpectancyR?: number;
    isSessionActive?: boolean;
}
export declare class ExecutionSafetyGate {
    /**
     * Evaluates all 12 mandatory quantitative and risk controls before granting order execution.
     */
    static evaluate(params: IExecutionSafetyGateParams): IExecutionSafetyDecision;
}
