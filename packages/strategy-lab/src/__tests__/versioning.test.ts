import { costModelVersion, labStrategyVersion } from '../versioning';
import { StrategyGenome } from '../types';

describe('strategy versioning', () => {
  const genome: StrategyGenome = { trigger: 'BREAKOUT_20', sides: 'LONG', filters: ['HTF_TREND'], stop: { type: 'ATR', atrMult: 2 }, rewardRisk: 3, maxBarsInTrade: 32, entryMode: 'MARKET', exit: 'FIXED' };
  const profile = { makerFeeRate: 0.0002, takerFeeRate: 0.0005, slippageRate: 0.0001 };
  const base = { symbol: 'BTCUSDT_PERP', timeframe: '1h', genome, riskPercentage: 3, leverage: 20, profile };
  const v = (o: any = {}) => labStrategyVersion({ ...base, ...o }).strategyVersion;

  it('is stable for identical inputs', () => {
    expect(v()).toBe(v());
    expect(v()).toMatch(/^sv-[0-9a-f]{12}$/);
  });

  it('changes with entry/stop/target/trailing rules, sizing, leverage and costs', () => {
    const variants = [
      v({ genome: { ...genome, stop: { type: 'ATR', atrMult: 3 } } }), // stop
      v({ genome: { ...genome, rewardRisk: 2 } }), // target
      v({ genome: { ...genome, exit: 'TRAIL', rewardRisk: 0 } }), // trailing
      v({ genome: { ...genome, filters: [] } }), // entry
      v({ riskPercentage: 1 }), // sizing
      v({ leverage: 10 }), // leverage
      v({ profile: { ...profile, takerFeeRate: 0.0004 } }), // costs
    ];
    expect(new Set([v(), ...variants]).size).toBe(variants.length + 1);
  });

  it('records each component so a version change can be explained', () => {
    const { components } = labStrategyVersion(base);
    expect(components).toEqual({
      genomeVersion: expect.stringContaining('BTCUSDT_PERP:1h:BREAKOUT_20'),
      engineVersion: 'trade-engine/v1',
      featureVersion: 'features/v1',
      costModelVersion: costModelVersion(profile),
      sizingVersion: 'risk 3% x20',
    });
  });
});
