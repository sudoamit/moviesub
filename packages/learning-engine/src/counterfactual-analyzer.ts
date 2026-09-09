import { BacktestSimulator } from '@quant/backtesting';
import { TradingExperience } from './types';

export interface CounterfactualExitScenario {
  scenarioName:
    | 'TP1_FIXED'
    | 'TP2_STANDARD'
    | 'TP3_RUNNER'
    | 'TRAILING_BREAKEVEN'
    | 'TIME_BASED_CUTOFF';
  simulatedExitPrice: number;
  simulatedPnLR: number;
  realizedDeltaR: number;
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
   * Analyzes a closed trading experience under alternative exit policies
   * strictly through the authoritative BacktestSimulator execution pipeline.
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

    const candles = (exp as any).candlesDuringTrade || [];
    if (!candles || candles.length < 2) {
      throw new Error('INSUFFICIENT_MARKET_DATA_FOR_COUNTERFACTUAL_ANALYSIS');
    }

    // Replay experience through authoritative BacktestSimulator for each counterfactual scenario
    const symbol = exp.instrument?.symbol || 'BTCUSDT';
    const timeframe = exp.timeframe || '15m';

    // 1. TP1 Fixed Scenario
    const resTp1 = BacktestSimulator.runSimulation({
      symbol,
      timeframe,
      candles,
      experiences: [exp],
      partialExitPolicy: { tp1Ratio: 1.0, tp2Ratio: 0, tp3Ratio: 0, moveStopToBreakevenOnTp1: false, trailStopOnTp2: false },
      minimumCandles: 2,
      warmupBars: 0,
    });
    const tp1PnLR = resTp1.trades[0]?.pnlRMultiple ?? actualPnLR;

    // 2. TP2 Standard Scenario
    const resTp2 = BacktestSimulator.runSimulation({
      symbol,
      timeframe,
      candles,
      experiences: [exp],
      partialExitPolicy: { tp1Ratio: 0.5, tp2Ratio: 0.5, tp3Ratio: 0, moveStopToBreakevenOnTp1: false, trailStopOnTp2: false },
      minimumCandles: 2,
      warmupBars: 0,
    });
    const tp2PnLR = resTp2.trades[0]?.pnlRMultiple ?? actualPnLR;

    // 3. TP3 Runner Scenario
    const resTp3 = BacktestSimulator.runSimulation({
      symbol,
      timeframe,
      candles,
      experiences: [exp],
      partialExitPolicy: { tp1Ratio: 0.33, tp2Ratio: 0.33, tp3Ratio: 0.34, moveStopToBreakevenOnTp1: false, trailStopOnTp2: false },
      minimumCandles: 2,
      warmupBars: 0,
    });
    const tp3PnLR = resTp3.trades[0]?.pnlRMultiple ?? actualPnLR;

    // 4. Trailing Breakeven Scenario
    const resBe = BacktestSimulator.runSimulation({
      symbol,
      timeframe,
      candles,
      experiences: [exp],
      enablePartialTp1Trailing: true,
      partialExitPolicy: { tp1Ratio: 0.5, tp2Ratio: 0.5, tp3Ratio: 0, moveStopToBreakevenOnTp1: true, trailStopOnTp2: false },
      minimumCandles: 2,
      warmupBars: 0,
    });
    const bePnLR = resBe.trades[0]?.pnlRMultiple ?? actualPnLR;

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
