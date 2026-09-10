import { DiscoveredPattern, FeatureSelectionResult, IErrorReport, StrategyCandidate, StrategyCandidateType } from './types';
import { ITrainedModelArtifact } from './model-trainer';

export interface ICandidateGeneratorInputs {
  baseStrategyVersion: string;
  errorReport: IErrorReport;
  patterns: DiscoveredPattern[];
  modelArtifact?: ITrainedModelArtifact;
  featureSelection?: FeatureSelectionResult;
  executionConfig?: {
    fillModel: 'OHLC_PATH' | 'CONSERVATIVE_CROSS' | 'AGGRESSIVE_BAR_HIGH_LOW' | 'TICK_INTERPOLATED';
    ambiguityMode: 'CONSERVATIVE' | 'OPTIMISTIC';
    latencyMs: number;
    minMtfScore: number;
    stopLossAtrMultiplier: number;
    sizingMultiplier: number;
  };
}

export class CandidateGenerator {
  private static candidateSeq = 1;

  /**
   * Translates error reports, discovered patterns, trained ML models, and feature selections
   * into structured machine-readable Strategy Candidates.
   */
  public static generateCandidates(inputs: ICandidateGeneratorInputs): StrategyCandidate[] {
    const candidates: StrategyCandidate[] = [];
    const baseVersion = inputs.baseStrategyVersion || 'v2.0';

    const execConfig = inputs.executionConfig ?? {
      fillModel: 'OHLC_PATH',
      ambiguityMode: 'CONSERVATIVE',
      latencyMs: 50,
      minMtfScore: 0.5,
      stopLossAtrMultiplier: 1.0,
      sizingMultiplier: 1.0,
    };

    const defaultRiskConfig = {
      initialCapital: 100000,
      maxRiskPerTrade: 0.02,
      riskRewardRatio: 2.0,
      partialExitPolicy: {
        tp1Ratio: 0.33,
        tp2Ratio: 0.33,
        tp3Ratio: 0.34,
        moveStopToBreakevenOnTp1: true,
        trailStopOnTp2: true,
        trailStopOffsetR: 1.0,
      },
      trailingStop: {
        enabled: true,
        activationR: 1.5,
        trailingDistanceR: 1.0,
      },
    };

    // 1. Generate Filter Candidates from Negative Patterns
    const negativePatterns = inputs.patterns.filter((p) => p.type === 'NEGATIVE_FILTER');
    for (const pat of negativePatterns) {
      const candidateVersion = `${baseVersion}-cand-neg-${this.candidateSeq++}`;
      const filterDesc = `Reject setups matching loss-inducing condition: [${pat.conditions.join(' AND ')}]`;

      candidates.push({
        id: `cand-${Date.now()}-${this.candidateSeq}`,
        baseStrategyVersion: baseVersion,
        candidateVersion,
        type: 'FILTER',
        description: filterDesc,
        symbol: 'BTCUSDT',
        riskConfig: defaultRiskConfig,
        change: {
          action: 'ADD_FILTER_RULE',
          minMtfScore: execConfig.minMtfScore,
          stopLossAtrMultiplier: execConfig.stopLossAtrMultiplier,
          sizingMultiplier: execConfig.sizingMultiplier,
          fillModel: execConfig.fillModel,
          ambiguityMode: execConfig.ambiguityMode,
          latencyMs: execConfig.latencyMs,
          conditionRules: pat.conditions,
          rejectWhenMatched: true,
        },
        evidence: {
          sampleSize: pat.sampleSize,
          expectancyBefore: pat.expectancy,
          expectancyAfterHistorical: pat.expectancy,
        },
        status: 'GENERATED',
        createdAt: new Date(),
      });
    }

    // 2. Generate Threshold Candidates from Top Loss Drivers in Error Report
    for (const driver of inputs.errorReport.topLossDrivers) {
      if (driver.count >= 5) {
        let type: StrategyCandidateType = 'THRESHOLD';
        let change: Record<string, unknown> = {};
        let desc = '';

        if (driver.failureMode === 'HTF_CONFLICT') {
          type = 'FILTER';
          desc = `Strictly enforce Multi-Timeframe Trend alignment. Require MTF score >= 12/15.`;
          change = { parameter: 'minMtfScore', value: 12, minMtfScore: 12 };
        } else if (driver.failureMode === 'VOLATILITY_MISREAD') {
          type = 'VOLATILITY';
          desc = `Apply 50% position sizing penalty or freeze entries during HIGH_VOLATILITY shocks.`;
          change = { parameter: 'highVolatilitySizingMultiplier', value: 0.5, sizingMultiplier: 0.5 };
        } else if (driver.failureMode === 'STOP_TOO_TIGHT') {
          type = 'EXIT';
          desc = `Widen minimum structural stop buffer by 1.25x ATR to avoid premature whipsaws.`;
          change = { parameter: 'stopLossAtrMultiplier', value: 1.25, stopLossAtrMultiplier: 1.25 };
        } else if (driver.failureMode === 'TARGET_TOO_FAR') {
          type = 'EXIT';
          desc = `Implement partial take-profit at 1.5R with immediate breakeven trailing.`;
          change = { parameter: 'enablePartialTp1Trailing', value: true };
        } else {
          desc = `Add candidate mitigation for failure mode ${driver.failureMode}.`;
          change = { parameter: 'generalMitigation', mode: driver.failureMode };
        }

        candidates.push({
          id: `cand-${Date.now()}-${this.candidateSeq++}`,
          baseStrategyVersion: baseVersion,
          candidateVersion: `${baseVersion}-cand-err-${this.candidateSeq}`,
          type,
          description: desc,
          symbol: 'BTCUSDT',
          riskConfig: defaultRiskConfig,
          change: {
            minMtfScore: execConfig.minMtfScore,
            stopLossAtrMultiplier: execConfig.stopLossAtrMultiplier,
            sizingMultiplier: execConfig.sizingMultiplier,
            fillModel: execConfig.fillModel,
            ambiguityMode: execConfig.ambiguityMode,
            latencyMs: execConfig.latencyMs,
            ...change,
          },
          evidence: {
            sampleSize: driver.count,
            expectancyBefore: driver.averageR,
            expectancyAfterHistorical: driver.averageR,
          },
          status: 'GENERATED',
          createdAt: new Date(),
        });
      }
    }

    // 3. Generate Confluence Boosters from Positive Patterns
    const positivePatterns = inputs.patterns.filter((p) => p.type === 'POSITIVE_CONFLUENCE');
    for (const pat of positivePatterns) {
      candidates.push({
        id: `cand-${Date.now()}-${this.candidateSeq++}`,
        baseStrategyVersion: baseVersion,
        candidateVersion: `${baseVersion}-cand-pos-${this.candidateSeq}`,
        type: 'THRESHOLD',
        description: `Boost conviction & position size when high-confluence condition holds: [${pat.conditions.join(' AND ')}]`,
        symbol: 'BTCUSDT',
        riskConfig: defaultRiskConfig,
        change: {
          action: 'BOOST_CONFIRMATION',
          minMtfScore: execConfig.minMtfScore,
          stopLossAtrMultiplier: execConfig.stopLossAtrMultiplier,
          sizingMultiplier: execConfig.sizingMultiplier,
          fillModel: execConfig.fillModel,
          ambiguityMode: execConfig.ambiguityMode,
          latencyMs: execConfig.latencyMs,
          conditionRules: pat.conditions,
          convictionMultiplier: 1.2,
        },
        evidence: {
          sampleSize: pat.sampleSize,
          expectancyBefore: pat.expectancy,
          expectancyAfterHistorical: pat.expectancy,
        },
        status: 'GENERATED',
        createdAt: new Date(),
      });
    }

    // 4. Generate Model Candidate from Trained Model Artifact
    if (inputs.modelArtifact) {
      candidates.push({
        id: `cand-${Date.now()}-${this.candidateSeq++}`,
        baseStrategyVersion: baseVersion,
        candidateVersion: `${baseVersion}-cand-model-${inputs.modelArtifact.modelVersion}`,
        type: 'MODEL',
        targetComponent: 'MODEL',
        description: `Apply trained canonical ML model filter (Version: ${inputs.modelArtifact.modelVersion}, Min Prob: 0.55)`,
        symbol: 'BTCUSDT',
        riskConfig: defaultRiskConfig,
        change: {
          parameter: 'minProbability',
          minProbability: 0.55,
          value: 0.55,
          minMtfScore: execConfig.minMtfScore,
          stopLossAtrMultiplier: execConfig.stopLossAtrMultiplier,
          sizingMultiplier: execConfig.sizingMultiplier,
          fillModel: execConfig.fillModel,
          ambiguityMode: execConfig.ambiguityMode,
          latencyMs: execConfig.latencyMs,
          modelArtifact: inputs.modelArtifact,
          featureSchemaHash: inputs.modelArtifact.featureSchemaHash,
          modelHash: inputs.modelArtifact.modelHash,
        },
        evidence: {
          sampleSize: inputs.modelArtifact.sampleCount,
          expectancyBefore: 0,
          expectancyAfterHistorical: 0,
        },
        status: 'GENERATED',
        createdAt: new Date(),
      });
    }

    // 5. Generate Feature Candidate from Feature Selection
    if (inputs.featureSelection && inputs.featureSelection.prunedFeatures.length > 0) {
      candidates.push({
        id: `cand-${Date.now()}-${this.candidateSeq++}`,
        baseStrategyVersion: baseVersion,
        candidateVersion: `${baseVersion}-cand-feature-${this.candidateSeq}`,
        type: 'FEATURE',
        targetComponent: 'FEATURE_SELECTION',
        description: `Prune low-importance features: [${inputs.featureSelection.prunedFeatures.join(', ')}]`,
        symbol: 'BTCUSDT',
        riskConfig: defaultRiskConfig,
        change: {
          parameter: 'featurePruning',
          minMtfScore: execConfig.minMtfScore,
          stopLossAtrMultiplier: execConfig.stopLossAtrMultiplier,
          sizingMultiplier: execConfig.sizingMultiplier,
          fillModel: execConfig.fillModel,
          ambiguityMode: execConfig.ambiguityMode,
          latencyMs: execConfig.latencyMs,
          selectedFeatures: inputs.featureSelection.retainedFeatures,
          prunedFeatures: inputs.featureSelection.prunedFeatures,
        },
        evidence: {
          sampleSize: 10,
          expectancyBefore: inputs.featureSelection.baselineExpectancy,
          expectancyAfterHistorical: inputs.featureSelection.optimizedExpectancy,
        },
        status: 'GENERATED',
        createdAt: new Date(),
      });
    }

    return candidates;
  }
}
