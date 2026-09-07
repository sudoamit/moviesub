import { AssetType, Direction, ICandle, Timeframe } from '@quant/shared';
import { SMCAnalyzer } from '../smc-analyzer';
import {
  DecisionTrace,
  InstrumentIdentity,
  PointInTimeMarketSnapshot,
  QuantSMCScore,
} from './quant-types';
import { QuantFeatureEngine } from './quant-feature-engine';
import { RegimeClusteringEngine } from './regime-clustering-engine';
import { VolatilityEngine } from './volatility-engine';
import { MultiHorizonEngine } from './multi-horizon-engine';
import { QuantSMCScorer } from './quant-smc-scorer';
import { CanonicalMLEngineV2 } from './canonical-ml-v2';
import { LLMContextLayer } from './llm-context-layer';
import { CandleNormalizer } from '../candle-normalizer';

export interface IBuildSnapshotOptions {
  symbol: string;
  executionCandles: ICandle[];
  executionTimeframe?: Timeframe | string;
  htf1Candles?: ICandle[];
  htf1Timeframe?: Timeframe | string;
  htf2Candles?: ICandle[];
  htf2Timeframe?: Timeframe | string;
  asOfTimestamp?: Date;
  instrument?: Partial<InstrumentIdentity>;
}

export class SnapshotBuilder {
  /**
   * Constructs a canonical, immutable PointInTimeMarketSnapshot without lookahead.
   */
  public static buildSnapshot(options: IBuildSnapshotOptions): PointInTimeMarketSnapshot {
    const symbol = options.symbol.toUpperCase();
    const rawCandles = CandleNormalizer.normalize(options.executionCandles);

    // Strict point-in-time candle slicing for execution and HTF datasets
    let execCandles = rawCandles;
    let htf1Candles = options.htf1Candles ? CandleNormalizer.normalize(options.htf1Candles) : undefined;
    let htf2Candles = options.htf2Candles ? CandleNormalizer.normalize(options.htf2Candles) : undefined;

    if (options.asOfTimestamp) {
      execCandles = CandleNormalizer.getClosedCandlesAsOf(
        rawCandles,
        options.executionTimeframe || Timeframe.M15,
        options.asOfTimestamp,
      );
      if (htf1Candles) {
        htf1Candles = CandleNormalizer.getClosedCandlesAsOf(
          htf1Candles,
          options.htf1Timeframe || Timeframe.H1,
          options.asOfTimestamp,
        );
      }
      if (htf2Candles) {
        htf2Candles = CandleNormalizer.getClosedCandlesAsOf(
          htf2Candles,
          options.htf2Timeframe || Timeframe.H4,
          options.asOfTimestamp,
        );
      }
    }

    const n = execCandles.length;
    const lastCandle = n > 0 ? execCandles[n - 1] : null;
    const timestamp = lastCandle
      ? new Date(lastCandle.timestamp)
      : options.asOfTimestamp || new Date();
    const marketPrice = lastCandle ? lastCandle.close : 0;

    // 1. Determine Asset Type & Metadata
    const isCrypto = symbol.includes('BTC') || symbol.includes('ETH') || symbol.includes('USDT');
    const isIndex = symbol === 'NIFTY' || symbol === 'BANKNIFTY' || symbol === 'FINNIFTY';
    const assetType =
      options.instrument?.assetType ||
      (isCrypto ? AssetType.CRYPTO : isIndex ? AssetType.INDEX : AssetType.EQUITY);

    const instrument: InstrumentIdentity = {
      symbol,
      assetType,
      exchange: isCrypto ? 'BINANCE' : 'NSE',
      currency: isCrypto ? 'USDT' : 'INR',
      lotSize: symbol === 'NIFTY' ? 65 : symbol === 'BANKNIFTY' ? 15 : isCrypto ? 0.01 : 1,
      tickSize: isCrypto ? 0.1 : 0.05,
      ...options.instrument,
    };

    // 2. SMC Analysis (strictly point-in-time)
    const smc = SMCAnalyzer.analyze(execCandles, { asOfTimestamp: timestamp });

    // 3. Quant Features & Normalization
    const quant = QuantFeatureEngine.extractQuantState(symbol, execCandles, smc);

    // 4. Regime Clustering
    const allSwings = smc.confirmedSwingHighs.concat(smc.confirmedSwingLows);
    const regime = RegimeClusteringEngine.classifyRegime(execCandles, allSwings);

    // 5. Volatility State
    const volatility = VolatilityEngine.computeVolatilityState(execCandles);

    // 6. Multi-Horizon Engine
    const multiHorizon = MultiHorizonEngine.evaluateMultiHorizon(
      execCandles,
      htf1Candles,
      htf2Candles,
    );

    // 7. Determine Candidate Direction
    let candidateDir = multiHorizon.higherTimeframe.trend;
    if (candidateDir === Direction.NEUTRAL) {
      candidateDir = smc.currentTrend;
    }
    if (candidateDir === Direction.NEUTRAL) {
      candidateDir = Direction.BULLISH;
    }

    const isBull = candidateDir === Direction.BULLISH;

    // Check SMC Components
    const hasSweep = smc.liquiditySweeps.length > 0;
    const hasBOS = smc.breaksOfStructure.some((b) => b.direction === candidateDir);
    const hasCHOCH = smc.changesOfCharacter.some((c) => c.direction === candidateDir);
    const activeOB = smc.activeOrderBlocks.find((ob) => ob.direction === candidateDir) || null;
    const activeFVG = smc.activeFVGs.find((fvg) => fvg.direction === candidateDir) || null;

    let inCorrectEquilibrium = true;
    if (smc.dealingRange) {
      if (isBull && marketPrice > smc.dealingRange.equilibrium * 1.01) inCorrectEquilibrium = false;
      if (!isBull && marketPrice < smc.dealingRange.equilibrium * 0.99)
        inCorrectEquilibrium = false;
    }

    // Measure structure strength and risk/reward ratio dynamically
    const structureStrength = (hasBOS ? 40 : 0) + (hasCHOCH ? 30 : 0) + (hasSweep ? 30 : 0);
    let riskRewardRatio = 2.0;
    if (smc.dealingRange) {
      const target = isBull ? smc.dealingRange.high : smc.dealingRange.low;
      const riskRef = isBull
        ? (activeOB ? activeOB.low : (smc.confirmedSwingLows[smc.confirmedSwingLows.length - 1]?.price || marketPrice * 0.99))
        : (activeOB ? activeOB.high : (smc.confirmedSwingHighs[smc.confirmedSwingHighs.length - 1]?.price || marketPrice * 1.01));
      const rewardDist = Math.abs(target - marketPrice);
      const riskDist = Math.max(1e-4, Math.abs(marketPrice - riskRef));
      riskRewardRatio = Math.max(1.0, Math.min(5.0, rewardDist / riskDist));
    }

    // 8. 10-Pillar Quant + SMC Confluence Score
    const score: QuantSMCScore = QuantSMCScorer.score({
      direction: candidateDir,
      hasBOS,
      hasCHOCH,
      structureStrength,
      mtfAlignment: multiHorizon.alignment,
      mtfConfluenceScore: multiHorizon.confluenceScore,
      hasLiquiditySweep: hasSweep,
      hasOrderBlock: activeOB !== null,
      obStrength: activeOB ? Math.min(100, activeOB.strength * 40) : 0,
      hasFVG: activeFVG !== null,
      relativeVolume: quant.momentum.relativeVolume,
      rsiValue: quant.momentum.rsi14,
      regime: regime.regime,
      volatilityPercentile: volatility.volatilityPercentile,
      riskRewardRatio,
      inCorrectEquilibriumZone: inCorrectEquilibrium,
    });

    // 9. Decision Trace Construction
    const whyThisTradeRanked = score.rankingRationale;
    const invalidationRisks: string[] = [];

    if (!inCorrectEquilibrium) {
      invalidationRisks.push(`Price is outside optimal discount/premium dealing range.`);
    }
    if (multiHorizon.alignment === 'CONFLICTED') {
      invalidationRisks.push(`Macro vs Execution timeframe trend mismatch.`);
    }
    if (regime.regime === 'HIGH_VOLATILITY') {
      invalidationRisks.push(
        `Elevated volatility percentile (${volatility.volatilityPercentile}%) requires wider stop.`,
      );
    }

    const trace: DecisionTrace = {
      timestamp,
      symbol,
      timeframe: String(options.executionTimeframe || '15m'),
      smc: {
        bias: candidateDir,
        bos: hasBOS ? 'CONFIRMED' : 'NONE',
        choch: hasCHOCH ? 'DETECTED' : 'NONE',
        liquidity: hasSweep ? 'SWEPT' : 'POOLS_PRESENT',
        ob: activeOB ? `VALID [${activeOB.low.toFixed(2)} - ${activeOB.high.toFixed(2)}]` : 'NONE',
        fvg: activeFVG
          ? `VALID [${activeFVG.lowerBound.toFixed(2)} - ${activeFVG.upperBound.toFixed(2)}]`
          : 'NONE',
      },
      quant: {
        regime: regime.regime,
        volatility: volatility.volatilityBucket,
        forecastVol: volatility.forecastVolatility,
        momentum: quant.momentum.rsi14,
        relativeVolume: quant.momentum.relativeVolume,
      },
      ml: {
        probability: null,
        expectedR: null,
        confidence: null,
      },
      multiHorizon: {
        alignment: multiHorizon.alignment,
        confluenceScore: multiHorizon.confluenceScore,
      },
      risk: {
        approved: score.totalScore >= 60 && multiHorizon.alignment !== 'CONFLICTED',
        positionSizeMultiplier: regime.regime === 'HIGH_VOLATILITY' ? 0.5 : 1.0,
        reasons:
          invalidationRisks.length === 0
            ? ['All deterministic and risk gates passed.']
            : invalidationRisks,
      },
      finalDecision:
        score.totalScore >= 75 && multiHorizon.alignment !== 'CONFLICTED'
          ? isBull
            ? 'BUY'
            : 'SELL'
          : score.totalScore >= 50
            ? 'WAIT'
            : 'NO_TRADE',
      whyThisTradeRanked,
      invalidationRisks,
    };

    // 10. Assemble Snapshot
    const snapshot: PointInTimeMarketSnapshot = {
      instrument,
      timestamp,
      marketPrice,
      candles: [
        {
          timeframe: String(options.executionTimeframe || '15m'),
          lastClosedTimestamp: timestamp,
          candlesUsed: execCandles.length,
        },
      ],
      smc,
      quant,
      regime,
      volatility,
      multiHorizon,
      score,
      trace,
    };

    // 11. Run Canonical ML v2 prediction
    const mlFeatures = CanonicalMLEngineV2.extractFeatures(snapshot);
    const mlPrediction = CanonicalMLEngineV2.predict(mlFeatures, null);
    snapshot.ml = mlPrediction;
    snapshot.trace.ml = {
      probability: mlPrediction.probabilityWin,
      expectedR: mlPrediction.expectedR,
      confidence: mlPrediction.confidence,
    };

    // 12. Optional LLM contextual assessment
    snapshot.trace.llmAssessment = LLMContextLayer.getDeterministicFallback(snapshot);

    return snapshot;
  }
}
