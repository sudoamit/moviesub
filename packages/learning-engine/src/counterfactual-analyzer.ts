import { TradingExperience } from './types';

export interface CounterfactualExitScenario {
  scenarioName:
    'TP1_FIXED' | 'TP2_STANDARD' | 'TP3_RUNNER' | 'TRAILING_BREAKEVEN' | 'TIME_BASED_CUTOFF';
  simulatedExitPrice: number;
  simulatedPnLR: number;
  realizedDeltaR: number; // counterfactual R - actual R
  wasSuperiorToActual: boolean;
}

export interface TradeCounterfactualAnalysis {
  tradeId: string;
  symbol: string;
  actualExitPrice: number;
  actualPnLR: number;
  scenarios: CounterfactualExitScenario[];
  optimalScenario: CounterfactualExitScenario;
  opportunityLossR: number;
}

export class CounterfactualAnalyzer {
  /**
   * Analyzes a closed trading experience under alternative exit policies.
   * STRICT POINT-IN-TIME GUARANTEE: Uses only ex-post trade telemetry for post-mortem learning,
   * never leaking future information into live decision gates.
   */
  public static analyzeExperience(exp: TradingExperience): TradeCounterfactualAnalysis {
    const entryPrice = exp.execution?.entryPrice || 0;
    const actualExitPrice = exp.execution?.exitPrice || entryPrice;
    const actualPnLR = exp.outcome?.pnlR || 0;
    const isBuy = exp.decision?.action === 'BUY';
    const riskDistance = exp.risk?.stopLoss
      ? Math.abs(entryPrice - exp.risk.stopLoss)
      : entryPrice * 0.01;

    const target1 =
      exp.risk?.target1 ||
      (isBuy ? entryPrice + 1.5 * riskDistance : entryPrice - 1.5 * riskDistance);
    const target2 =
      exp.risk?.target2 ||
      (isBuy ? entryPrice + 2.5 * riskDistance : entryPrice - 2.5 * riskDistance);
    const target3 =
      exp.risk?.target3 ||
      (isBuy ? entryPrice + 4.0 * riskDistance : entryPrice - 4.0 * riskDistance);

    const mfe = exp.outcome?.maxFavorableExcursion || 0;

    // Scenario 1: TP1 Fixed Exit (1.5R)
    const tp1Reached = mfe >= 1.5;
    const tp1PnLR = tp1Reached ? 1.5 : actualPnLR < 0 ? -1.0 : actualPnLR;
    const tp1Scenario: CounterfactualExitScenario = {
      scenarioName: 'TP1_FIXED',
      simulatedExitPrice: target1,
      simulatedPnLR: tp1PnLR,
      realizedDeltaR: Number((tp1PnLR - actualPnLR).toFixed(2)),
      wasSuperiorToActual: tp1PnLR > actualPnLR,
    };

    // Scenario 2: TP2 Standard Exit (2.5R)
    const tp2Reached = mfe >= 2.5;
    const tp2PnLR = tp2Reached ? 2.5 : actualPnLR < 0 ? -1.0 : actualPnLR;
    const tp2Scenario: CounterfactualExitScenario = {
      scenarioName: 'TP2_STANDARD',
      simulatedExitPrice: target2,
      simulatedPnLR: tp2PnLR,
      realizedDeltaR: Number((tp2PnLR - actualPnLR).toFixed(2)),
      wasSuperiorToActual: tp2PnLR > actualPnLR,
    };

    // Scenario 3: TP3 Runner Exit (4.0R)
    const tp3Reached = mfe >= 4.0;
    const tp3PnLR = tp3Reached ? 4.0 : tp1Reached ? 0.0 : -1.0; // trailing to BE after TP1
    const tp3Scenario: CounterfactualExitScenario = {
      scenarioName: 'TP3_RUNNER',
      simulatedExitPrice: target3,
      simulatedPnLR: tp3PnLR,
      realizedDeltaR: Number((tp3PnLR - actualPnLR).toFixed(2)),
      wasSuperiorToActual: tp3PnLR > actualPnLR,
    };

    // Scenario 4: Trailing Breakeven (0.0R on pullback if +1.5R MFE reached)
    const bePnLR = tp1Reached ? Math.max(0.0, actualPnLR) : actualPnLR;
    const beScenario: CounterfactualExitScenario = {
      scenarioName: 'TRAILING_BREAKEVEN',
      simulatedExitPrice: entryPrice,
      simulatedPnLR: bePnLR,
      realizedDeltaR: Number((bePnLR - actualPnLR).toFixed(2)),
      wasSuperiorToActual: bePnLR > actualPnLR,
    };

    const scenarios = [tp1Scenario, tp2Scenario, tp3Scenario, beScenario];
    const optimalScenario = [...scenarios].sort((a, b) => b.simulatedPnLR - a.simulatedPnLR)[0];
    const opportunityLossR = Math.max(
      0,
      Number((optimalScenario.simulatedPnLR - actualPnLR).toFixed(2)),
    );

    return {
      tradeId: exp.tradeId || exp.id,
      symbol: exp.instrument?.symbol || 'UNKNOWN',
      actualExitPrice,
      actualPnLR,
      scenarios,
      optimalScenario,
      opportunityLossR,
    };
  }

  /**
   * Evaluates counterfactuals across a portfolio of experiences to identify system-wide exit inefficiencies.
   */
  public static analyzeBatch(experiences: TradingExperience[]): {
    totalOpportunityLossR: number;
    recommendedExitPolicy: string;
    tp1SuperiorityPct: number;
    tp2SuperiorityPct: number;
    trailingBESuperiorityPct: number;
  } {
    if (!experiences || experiences.length === 0) {
      return {
        totalOpportunityLossR: 0,
        recommendedExitPolicy: 'TP2_STANDARD',
        tp1SuperiorityPct: 0,
        tp2SuperiorityPct: 0,
        trailingBESuperiorityPct: 0,
      };
    }

    const analyses = experiences.map((e) => this.analyzeExperience(e));
    const totalLoss = analyses.reduce((acc, a) => acc + a.opportunityLossR, 0);

    const tp1Wins = analyses.filter((a) => a.optimalScenario.scenarioName === 'TP1_FIXED').length;
    const tp2Wins = analyses.filter(
      (a) => a.optimalScenario.scenarioName === 'TP2_STANDARD',
    ).length;
    const beWins = analyses.filter(
      (a) => a.optimalScenario.scenarioName === 'TRAILING_BREAKEVEN',
    ).length;

    const count = analyses.length;
    let recommended = 'TP2_STANDARD';
    if (tp1Wins > tp2Wins && tp1Wins > beWins) recommended = 'TP1_FIXED';
    if (beWins > tp1Wins && beWins > tp2Wins) recommended = 'TRAILING_BREAKEVEN';

    return {
      totalOpportunityLossR: Number(totalLoss.toFixed(2)),
      recommendedExitPolicy: recommended,
      tp1SuperiorityPct: Number(((tp1Wins / count) * 100).toFixed(1)),
      tp2SuperiorityPct: Number(((tp2Wins / count) * 100).toFixed(1)),
      trailingBESuperiorityPct: Number(((beWins / count) * 100).toFixed(1)),
    };
  }
}
