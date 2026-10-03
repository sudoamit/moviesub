import { createHash } from 'crypto';
import { COST_MODEL_VERSION } from '@quant/shared';
import { genomeId } from './genome';
import { TRADE_ENGINE_VERSION } from './trade-engine';
import { InstrumentProfile, StrategyGenome } from './types';

/**
 * STRATEGY VERSIONING. Anything that changes what a strategy trades or how its results are measured is part of
 * its version: rules (genome), the trade engine, the feature definitions, the cost model and the sizing (risk %
 * and leverage). A change produces a new strategyVersion; results recorded under another version are not evidence
 * for the new one. (Quality-model versions are recorded per trade instead: they are retrained after every closed
 * trade and only ever reduce exposure - see quality.ts qualityDecision.)
 */
export const FEATURE_VERSION = 'features/v1';
/** 17 inputs incl. the PVSRA liquidity features */
export const QUALITY_FEATURE_VERSION = 'quality-features/v2';

const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Cost model identity: changes whenever the instrument's fee or slippage assumptions change. */
export function costModelVersion(profile: Pick<InstrumentProfile, 'makerFeeRate' | 'takerFeeRate' | 'slippageRate'>): string {
  // COST_MODEL_VERSION changes with the cost DEFINITION (e.g. the cost-vs-risk gate), the hash with the RATES
  return `${COST_MODEL_VERSION}:${short(`${profile.makerFeeRate}|${profile.takerFeeRate}|${profile.slippageRate}`)}`;
}

export interface StrategyVersionComponents {
  genomeVersion: string;
  engineVersion: string;
  featureVersion: string;
  costModelVersion: string;
  sizingVersion: string;
}

export function labStrategyVersion(input: {
  symbol: string;
  timeframe: string;
  genome: StrategyGenome;
  riskPercentage: number;
  leverage: number;
  profile: Pick<InstrumentProfile, 'makerFeeRate' | 'takerFeeRate' | 'slippageRate'>;
}): { strategyVersion: string; components: StrategyVersionComponents } {
  const components: StrategyVersionComponents = {
    genomeVersion: `${input.symbol}:${input.timeframe}:${genomeId(input.genome)}`,
    engineVersion: TRADE_ENGINE_VERSION,
    featureVersion: FEATURE_VERSION,
    costModelVersion: costModelVersion(input.profile),
    sizingVersion: `risk ${input.riskPercentage}% x${input.leverage}`,
  };
  return { strategyVersion: `sv-${short(JSON.stringify(components))}`, components };
}
