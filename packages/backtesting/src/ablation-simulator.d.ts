import { IAblationStudyResult, IBacktestOptions } from './types';
export declare class AblationSimulator {
    /**
     * Runs an ablation study across 6 modular variants to measure out-of-sample feature delta.
     */
    static runAblationStudy(options: IBacktestOptions): IAblationStudyResult;
    /**
     * Runs granular component ablation across 8 core SMC/Quant elements (WITHOUT_LIQUIDITY, WITHOUT_OB, etc.)
     */
    static runFeatureComponentAblation(options: IBacktestOptions): import('./types').IComponentAblationResult;
}
