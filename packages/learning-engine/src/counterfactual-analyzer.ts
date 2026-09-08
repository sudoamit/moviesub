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

    const candles = (exp as any).candlesDuringTrade || [];
    let tp1PnLR = actualPnLR;
    let tp2PnLR = actualPnLR;
    let tp3PnLR = actualPnLR;
    let bePnLR = actualPnLR;

    if (candles && candles.length > 0 && riskDistance > 0) {
      // Evaluate sequential candle-by-candle trajectory
      let reachedTp1 = false;
      let reachedTp2 = false;
      let reachedTp3 = false;
      let stoppedOut = false;

      for (const c of candles) {
        if (stoppedOut) break;
        const high = c.high;
        const low = c.low;

        const slHit = isBuy ? low <= exp.risk.stopLoss : high >= exp.risk.stopLoss;
        const tp1Hit = isBuy ? high >= target1 : low <= target1;

        if (slHit && tp1Hit) {
          const openDistToSl = Math.abs(c.open - exp.risk.stopLoss);
          const openDistToTp = Math.abs(c.open - target1);
          if (openDistToTp < openDistToSl) {
            reachedTp1 = true;
            tp1PnLR = 1.5;
          } else {
            stoppedOut = true;
            if (!reachedTp1) tp1PnLR = -1.0;
            if (!reachedTp2) tp2PnLR = -1.0;
            if (!reachedTp3) tp3PnLR = reachedTp1 ? 0.0 : -1.0;
            if (!reachedTp1) bePnLR = -1.0;
            break;
          }
        } else if (slHit) {
          stoppedOut = true;
          if (!reachedTp1) tp1PnLR = -1.0;
          if (!reachedTp2) tp2PnLR = -1.0;
          if (!reachedTp3) tp3PnLR = reachedTp1 ? 0.0 : -1.0;
          if (!reachedTp1) bePnLR = -1.0;
          break;
        }

        // Check TP targets
        if (tp1Hit) {
          reachedTp1 = true;
          tp1PnLR = 1.5;
        }
        if (isBuy ? high >= target2 : low <= target2) {
          reachedTp2 = true;
          tp2PnLR = 2.5;
        }
        if (isBuy ? high >= target3 : low <= target3) {
          reachedTp3 = true;
          tp3PnLR = 4.0;
        }
      }
    } else {
      // Fallback: evaluate using realized trade outcome status and targets
      if (exp.outcome?.status === 'WIN') {
        tp1PnLR = 1.5;
        tp2PnLR = exp.outcome.pnlR >= 2.5 ? 2.5 : 1.5;
        tp3PnLR = exp.outcome.pnlR >= 4.0 ? 4.0 : 1.5;
        bePnLR = Math.max(0.0, actualPnLR);
      } else if (exp.outcome?.status === 'LOSS') {
        tp1PnLR = -1.0;
        tp2PnLR = -1.0;
        tp3PnLR = -1.0;
        bePnLR = -1.0;
      }
    }

    const tp1Scenario: CounterfactualExitScenario = {
      scenarioName: 'TP1_FIXED',
      simulatedExitPrice: target1,
      simulatedPnLR: tp1PnLR,
      realizedDeltaR: Number((tp1PnLR - actualPnLR).toFixed(2)),
      wasSuperiorToActual: tp1PnLR > actualPnLR,
    };

    const tp2Scenario: CounterfactualExitScenario = {
      scenarioName: 'TP2_STANDARD',
      simulatedExitPrice: target2,
      simulatedPnLR: tp2PnLR,
      realizedDeltaR: Number((tp2PnLR - actualPnLR).toFixed(2)),
      wasSuperiorToActual: tp2PnLR > actualPnLR,
    };

    const tp3Scenario: CounterfactualExitScenario = {
      scenarioName: 'TP3_RUNNER',
      simulatedExitPrice: target3,
      simulatedPnLR: tp3PnLR,
      realizedDeltaR: Number((tp3PnLR - actualPnLR).toFixed(2)),
      wasSuperiorToActual: tp3PnLR > actualPnLR,
    };

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
