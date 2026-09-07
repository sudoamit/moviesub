import { Direction, ISignalSetup, SignalGrade } from '@quant/shared';
import { FailureMode, TradeOutcomeClassification } from './types';

export interface ITradeOutcomeInputs {
  tradeId: string;
  symbol: string;
  direction: Direction;
  entryPrice: number;
  entryTime: Date;
  exitPrice: number;
  exitTime: Date;
  stopLoss: number;
  takeProfit1?: number;
  takeProfit2?: number;
  riskAmount?: number;
  pnl: number;
  pnlR: number;
  signalSetup?: ISignalSetup;
  candlesDuringTrade?: { high: number; low: number; timestamp: Date }[];
  marketRegime?: string;
  isExecutionSlippageExcessive?: boolean;
}

export interface IOutcomeAnalysisResult {
  outcomeClassification: TradeOutcomeClassification;
  outcomeStatus: 'WIN' | 'LOSS' | 'TIMEOUT' | 'SCRATCH';
  maxFavorableExcursion: number; // in R
  maxAdverseExcursion: number; // in R
  holdingTimeSeconds: number;
  failureReasons: FailureMode[];
  isExecutionSlippageExcessive: boolean;
  setupQualityScore: number; // 0 to 100
}

export class TradeOutcomeAnalyzer {
  /**
   * Evaluates decision quality vs realized outcome to classify the trade.
   */
  public static analyze(inputs: ITradeOutcomeInputs): IOutcomeAnalysisResult {
    const isLong = inputs.direction === Direction.BULLISH;
    const riskPerUnit = Math.abs(inputs.entryPrice - inputs.stopLoss);
    const holdingTimeSeconds = Math.max(
      0,
      Math.floor(
        (new Date(inputs.exitTime).getTime() - new Date(inputs.entryTime).getTime()) / 1000,
      ),
    );

    // 1. Calculate MFE & MAE in R-multiples
    let mfe = 0;
    let mae = 0;

    if (inputs.candlesDuringTrade && inputs.candlesDuringTrade.length > 0 && riskPerUnit > 0) {
      let maxFavDiff = 0;
      let maxAdvDiff = 0;

      for (const candle of inputs.candlesDuringTrade) {
        const favDiff = isLong ? candle.high - inputs.entryPrice : inputs.entryPrice - candle.low;
        const advDiff = isLong ? inputs.entryPrice - candle.low : candle.high - inputs.entryPrice;

        if (favDiff > maxFavDiff) maxFavDiff = favDiff;
        if (advDiff > maxAdvDiff) maxAdvDiff = advDiff;
      }

      mfe = Number((maxFavDiff / riskPerUnit).toFixed(2));
      mae = Number((maxAdvDiff / riskPerUnit).toFixed(2));
    } else if (riskPerUnit > 0) {
      // Fallback from exit price
      const realizedDiff = isLong
        ? inputs.exitPrice - inputs.entryPrice
        : inputs.entryPrice - inputs.exitPrice;
      mfe = realizedDiff > 0 ? Number((realizedDiff / riskPerUnit).toFixed(2)) : 0;
      mae = realizedDiff < 0 ? Number((Math.abs(realizedDiff) / riskPerUnit).toFixed(2)) : 0;
    }

    // 2. Determine Outcome Status
    let outcomeStatus: 'WIN' | 'LOSS' | 'TIMEOUT' | 'SCRATCH' = 'SCRATCH';
    if (inputs.pnlR >= 0.3) {
      outcomeStatus = 'WIN';
    } else if (inputs.pnlR <= -0.3) {
      outcomeStatus = 'LOSS';
    } else if (holdingTimeSeconds > 24 * 3600 && Math.abs(inputs.pnlR) < 0.3) {
      outcomeStatus = 'TIMEOUT';
    }

    // 3. Evaluate Setup Quality
    const score = inputs.signalSetup?.score ?? 70;
    const grade = inputs.signalSetup?.grade ?? SignalGrade.B;
    const htfAligned = inputs.signalSetup?.htfBias
      ? inputs.signalSetup.htfBias === inputs.direction
      : true;
    const isQualitySetup = score >= 70 && grade !== SignalGrade.NO_TRADE && htfAligned;

    // 4. Identify Failure Reasons
    const failureReasons: FailureMode[] = [];

    if (inputs.isExecutionSlippageExcessive) {
      failureReasons.push('SLIPPAGE');
    }

    if (!htfAligned) {
      failureReasons.push('HTF_CONFLICT');
    }

    if (inputs.marketRegime === 'HIGH_VOLATILITY') {
      failureReasons.push('VOLATILITY_MISREAD');
    }

    if (mae >= 1.0 && outcomeStatus === 'LOSS') {
      if (inputs.signalSetup?.stopLoss && riskPerUnit < inputs.entryPrice * 0.002) {
        failureReasons.push('STOP_TOO_TIGHT');
      } else {
        failureReasons.push('WRONG_DIRECTION');
      }
    }

    if (mfe >= 1.5 && outcomeStatus === 'LOSS') {
      failureReasons.push('TARGET_TOO_FAR');
    }

    if (outcomeStatus === 'TIMEOUT') {
      failureReasons.push('TIMEOUT_CHOP');
    }

    // 5. Institutional Decision vs Outcome Classification
    let outcomeClassification: TradeOutcomeClassification = 'GOOD_TRADE_WIN';

    if (inputs.isExecutionSlippageExcessive) {
      outcomeClassification = 'EXECUTION_FAILURE';
    } else if (outcomeStatus === 'WIN') {
      if (isQualitySetup) {
        outcomeClassification = 'GOOD_TRADE_WIN';
      } else {
        // Won despite bad setup / HTF conflict (Luck)
        outcomeClassification = 'BAD_TRADE_WIN';
        failureReasons.push('ML_FALSE_POSITIVE');
      }
    } else if (outcomeStatus === 'LOSS' || outcomeStatus === 'TIMEOUT') {
      if (isQualitySetup) {
        // High quality trade, followed all rules, standard statistical stop hit
        outcomeClassification = 'GOOD_TRADE_LOSS';
      } else {
        // Poor setup that should have been filtered out
        outcomeClassification = 'BAD_TRADE_LOSS';
        if (!htfAligned) failureReasons.push('HTF_CONFLICT');
        failureReasons.push('STRATEGY_FAILURE');
      }
    } else {
      outcomeClassification = isQualitySetup ? 'GOOD_TRADE_WIN' : 'BAD_TRADE_LOSS';
    }

    return {
      outcomeClassification,
      outcomeStatus,
      maxFavorableExcursion: mfe,
      maxAdverseExcursion: mae,
      holdingTimeSeconds,
      failureReasons,
      isExecutionSlippageExcessive: !!inputs.isExecutionSlippageExcessive,
      setupQualityScore: score,
    };
  }
}
