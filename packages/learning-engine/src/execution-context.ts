import { createHash } from 'crypto';
import {
  ExecutionCostStressConfig,
  IFeeConfig,
  ILatencyConfig,
  ISlippageConfig,
  ISpreadConfig,
} from '@quant/backtesting';
import { CandidateRiskConfig } from './types';
import { canonicalJsonStringify } from './canonical-serializer';

export const EXECUTION_CONTEXT_VERSION = '1.0';
export const EXECUTION_ENGINE_VERSION = 'backtesting-execution-v3.0.0';

export interface ProductionExecutionContextInput {
  readonly symbol: string;
  readonly timeframe: string;
  readonly minimumCandles: number;
  readonly warmupBars: number;
  readonly fillModel: string;
  readonly ambiguityMode: string;
  readonly latencyConfig: ILatencyConfig;
  readonly feeConfig?: IFeeConfig;
  readonly slippageConfig?: ISlippageConfig;
  readonly spreadConfig?: ISpreadConfig;
  readonly costStressConfig?: ExecutionCostStressConfig;
  readonly riskConfig: CandidateRiskConfig | Record<string, unknown>;
  readonly sizingConfig: Record<string, unknown>;
  readonly strategyVersion: string;
  readonly executionVersion: string;
}

export interface ProductionExecutionContext extends ProductionExecutionContextInput {
  readonly executionContextVersion: string;
  readonly executionContextHash: string;
  readonly executionContext: 'PRODUCTION' | 'EXPERIMENTAL';
  readonly productionEligible: boolean;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function computeExecutionContextHash(context: ProductionExecutionContextInput): string {
  const {
    symbol,
    timeframe,
    minimumCandles,
    warmupBars,
    fillModel,
    ambiguityMode,
    latencyConfig,
    feeConfig,
    slippageConfig,
    spreadConfig,
    costStressConfig,
    riskConfig,
    sizingConfig,
    strategyVersion,
    executionVersion,
  } = context;
  return createHash('sha256')
    .update(canonicalJsonStringify({
      executionContextVersion: EXECUTION_CONTEXT_VERSION,
      symbol,
      timeframe,
      minimumCandles,
      warmupBars,
      fillModel,
      ambiguityMode,
      latencyConfig,
      feeConfig,
      slippageConfig,
      spreadConfig,
      costStressConfig,
      riskConfig,
      sizingConfig,
      strategyVersion,
      executionVersion,
    }))
    .digest('hex');
}

export function createExecutionContext(
  input: ProductionExecutionContextInput,
  mode: 'PRODUCTION' | 'EXPERIMENTAL' = 'PRODUCTION',
): ProductionExecutionContext {
  if (!input.symbol || !input.timeframe || !input.strategyVersion || !input.executionVersion) {
    throw new Error('EXECUTION_CONTEXT_INCOMPLETE: symbol, timeframe, strategyVersion, and executionVersion are required');
  }
  if (!Number.isInteger(input.minimumCandles) || input.minimumCandles < 0) {
    throw new Error(`INVALID_EXECUTION_CONTEXT_MINIMUM_CANDLES:${input.minimumCandles}`);
  }
  if (!Number.isInteger(input.warmupBars) || input.warmupBars < 0) {
    throw new Error(`INVALID_EXECUTION_CONTEXT_WARMUP_BARS:${input.warmupBars}`);
  }

  const context: ProductionExecutionContext = {
    ...input,
    executionContextVersion: EXECUTION_CONTEXT_VERSION,
    executionContextHash: computeExecutionContextHash(input),
    executionContext: mode,
    productionEligible: mode === 'PRODUCTION',
  };
  return deepFreeze(context);
}

export function assertCompatibleExecutionContexts(
  champion: ProductionExecutionContext,
  challenger: ProductionExecutionContext,
  experimental = false,
): void {
  if (!experimental && champion.executionContextVersion !== challenger.executionContextVersion) {
    throw new Error(
      `INCOMPATIBLE_EXECUTION_CONTEXT_VERSION: Champion version ${champion.executionContextVersion} does not match challenger version ${challenger.executionContextVersion}`,
    );
  }
  if (!experimental && champion.executionContextHash !== challenger.executionContextHash) {
    throw new Error(
      `INCOMPATIBLE_EXECUTION_CONTEXT: Champion hash ${champion.executionContextHash} does not match challenger hash ${challenger.executionContextHash}`,
    );
  }
}
