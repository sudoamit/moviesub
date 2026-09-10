import { CandidateMarketDataset, StrategyCandidate, TradingExperience } from './types';
import { CandidateEvaluator } from './candidate-evaluator';
import { ICandle } from '@quant/shared';

export interface IRobustnessReport {
  candidateId: string;
  normalCostExpectancy: number;
  doubleCostExpectancy: number;
  tripleCostExpectancy: number;
  survivedDoubleCosts: boolean;
  survivedTripleCosts: boolean;
  breakEvenCostR: number;
  isRobust: boolean;
}

export class RobustnessEngine {
  /**
   * Stress tests candidate strategies against aggressive transaction costs, slippage, and spread widening
   * strictly on continuous market data.
   */
  public static evaluateCosts(
    candidate: StrategyCandidate,
    marketDataOrExperiences?: { candles?: ICandle[]; dataset?: CandidateMarketDataset } | ICandle[] | TradingExperience[],
    options?: { candles?: ICandle[]; dataset?: CandidateMarketDataset },
  ): IRobustnessReport {
    const isCandleArray =
      Array.isArray(marketDataOrExperiences) &&
      marketDataOrExperiences.length > 0 &&
      'open' in (marketDataOrExperiences[0] as any);

    const marketData: { candles?: ICandle[]; dataset?: CandidateMarketDataset } = isCandleArray
      ? { candles: marketDataOrExperiences as ICandle[] }
      : !Array.isArray(marketDataOrExperiences) && marketDataOrExperiences && ('candles' in marketDataOrExperiences || 'dataset' in marketDataOrExperiences)
        ? marketDataOrExperiences
        : { candles: options?.candles, dataset: options?.dataset };

    const minCandles = (marketData.candles && marketData.candles.length > 0)
      ? Math.min(10, marketData.candles.length)
      : (marketData.dataset?.executionCandles && marketData.dataset.executionCandles.length > 0)
        ? Math.min(10, marketData.dataset.executionCandles.length)
        : 10;
    const sym = marketData.dataset?.symbol || candidate.symbol || 'BTCUSDT';

    // 1. Normal Cost: 0.05R
    const normal = CandidateEvaluator.evaluateCandidateOnMarketData(candidate, marketData, {
      costPerTradeR: 0.05,
      minimumCandles: minCandles,
      symbol: sym,
    });
    // 2. Double Cost: 0.10R
    const doubleCost = CandidateEvaluator.evaluateCandidateOnMarketData(candidate, marketData, {
      costPerTradeR: 0.1,
      minimumCandles: minCandles,
      symbol: sym,
    });
    // 3. Triple Cost (Stress): 0.15R
    const tripleCost = CandidateEvaluator.evaluateCandidateOnMarketData(candidate, marketData, {
      costPerTradeR: 0.15,
      minimumCandles: minCandles,
      symbol: sym,
    });

    const normalExp = normal.candidateExpectancy;
    const doubleExp = doubleCost.candidateExpectancy;
    const tripleExp = tripleCost.candidateExpectancy;

    const survivedDouble = doubleExp > 0.05;
    const survivedTriple = tripleExp > 0.0;

    // Estimate Breakeven Transaction Cost in R
    const breakEvenCostR = Math.max(0, Number((normalExp + 0.05).toFixed(3)));
    const isRobust = survivedDouble && breakEvenCostR >= 0.12;

    return {
      candidateId: candidate.id,
      normalCostExpectancy: normalExp,
      doubleCostExpectancy: doubleExp,
      tripleCostExpectancy: tripleExp,
      survivedDoubleCosts: survivedDouble,
      survivedTripleCosts: survivedTriple,
      breakEvenCostR,
      isRobust,
    };
  }
}
