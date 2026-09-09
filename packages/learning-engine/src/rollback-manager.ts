import { ModelRegistry } from './model-registry';
import { StrategyRegistry } from './strategy-registry';
import { TradingExperience } from './types';

export interface IRollbackCheckResult {
  shouldRollback: boolean;
  activeStrategyVersion: string;
  previousStableVersion: string;
  recentExpectancyR: number;
  expectedBaselineR: number;
  triggerReason?: string;
}

export class RollbackManager {
  /**
   * Monitors live strategy performance against expected baseline and executes deterministic rollback upon degradation.
   */
  public static checkAndExecuteRollback(
    recentExperiences: TradingExperience[],
    minTradesForEvaluation = 15,
  ): IRollbackCheckResult {
    const activeStrat = StrategyRegistry.getActiveStrategy();
    const activeVersion = activeStrat?.strategyVersion || 'v2.0-smc-quant';
    const baselineR = activeStrat?.expectancyR || 0.42;

    const count = recentExperiences.length;
    if (count < minTradesForEvaluation) {
      return {
        shouldRollback: false,
        activeStrategyVersion: activeVersion,
        previousStableVersion: 'v2.0-smc-quant',
        recentExpectancyR: 0,
        expectedBaselineR: baselineR,
      };
    }

    const sumR = recentExperiences.reduce((sum, e) => sum + e.outcome.pnlR, 0);
    const recentExpR = Number((sumR / count).toFixed(2));

    // Severe degradation criteria: Recent expectancy negative or < 25% of baseline
    const isDegraded = recentExpR < 0.0 || recentExpR < baselineR * 0.25;

    let previousStable = 'v2.0-smc-quant';
    const all = StrategyRegistry.getAllStrategies();
    const prev = all.find((s) => s.strategyVersion !== activeVersion && (s.status === 'RETIRED' || s.status === 'ACTIVE'));
    if (prev) previousStable = prev.strategyVersion;

    let previousModelVersion = 'v2.0-ml-canonical';
    const activeModel = ModelRegistry.getActiveModel();
    const allModels = ModelRegistry.getAllModels();
    const prevModel = allModels.find(
      (m) => m.modelVersion !== activeModel?.modelVersion && (m.status === 'RETIRED' || m.status === 'ACTIVE'),
    );
    if (prevModel) previousModelVersion = prevModel.modelVersion;

    if (isDegraded && activeVersion !== previousStable) {
      const reason = `Performance degradation detected. Recent expectancy (${recentExpR}R) dropped significantly below baseline (${baselineR}R) across ${count} trades.`;

      // Execute atomic rollback in strategy registry
      StrategyRegistry.rollbackStrategy(previousStable);

      return {
        shouldRollback: true,
        activeStrategyVersion: activeVersion,
        previousStableVersion: previousStable,
        recentExpectancyR: recentExpR,
        expectedBaselineR: baselineR,
        triggerReason: reason,
      };
    }

    return {
      shouldRollback: false,
      activeStrategyVersion: activeVersion,
      previousStableVersion: previousStable,
      recentExpectancyR: recentExpR,
      expectedBaselineR: baselineR,
    };
  }
}
