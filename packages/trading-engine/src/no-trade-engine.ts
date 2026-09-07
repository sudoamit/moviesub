import { ISignalSetup, Direction, SignalGrade } from '@quant/shared';

export type NoTradeReason =
  | 'HTF_CONFLICT'
  | 'LOW_LIQUIDITY'
  | 'HIGH_VOLATILITY'
  | 'LOW_EXPECTED_VALUE'
  | 'BAD_RR'
  | 'DAILY_RISK_LIMIT'
  | 'DRAWDOWN_LIMIT'
  | 'CORRELATED_EXPOSURE'
  | 'SESSION_FILTER'
  | 'MODEL_UNCERTAINTY'
  | 'EXECUTION_RISK';

export interface INoTradeContext {
  isSessionActive?: boolean;
  marketRegime?: string;
  expectedR?: number;
  mlProbability?: number;
  isDrawdownHalted?: boolean;
  correlatedExposurePercent?: number;
  minScoreThreshold?: number;
  minRRThreshold?: number;
  minExpectedR?: number;
}

export interface ITradeDecision {
  decision: 'ALLOW' | 'BLOCK';
  isAllowed: boolean;
  reasons: NoTradeReason[];
  explanation: string;
  confidence: number;
  riskAdjustedExpectancy: number;
}

export class NoTradeEngine {
  /**
   * Evaluates whether a generated signal meets strict institutional risk-adjusted expectancy criteria.
   * "NO TRADE" is treated as a first-class, capital-preserving decision.
   */
  static evaluateTradePermission(
    signal: ISignalSetup,
    context: INoTradeContext = {},
  ): ITradeDecision {
    const reasons: NoTradeReason[] = [];
    const explanations: string[] = [];

    const minScore = context.minScoreThreshold ?? 65;
    const minRR = context.minRRThreshold ?? 1.5;
    const minExpectedR = context.minExpectedR ?? 0.2;

    // 1. Neutral direction / No Trade grade
    if (signal.direction === Direction.NEUTRAL || signal.grade === SignalGrade.NO_TRADE || signal.score < minScore) {
      reasons.push('LOW_EXPECTED_VALUE');
      explanations.push(`Signal score (${signal.score}/100) below minimum conviction threshold (${minScore})`);
    }

    // 2. Risk-Reward Ratio threshold
    const riskDistance = Math.abs(signal.entryZone.optimal - signal.stopLoss);
    const rewardDistance = Math.abs((signal.takeProfits?.tp2 || signal.takeProfits?.tp1 || 0) - signal.entryZone.optimal);
    const calculatedRR = riskDistance > 0 ? rewardDistance / riskDistance : 0;
    if (calculatedRR < minRR) {
      reasons.push('BAD_RR');
      explanations.push(`Risk-Reward ratio (${calculatedRR.toFixed(2)}R) below minimum required (${minRR}R)`);
    }

    // 3. Higher Timeframe Conflict
    if (signal.scoreBreakdown && signal.scoreBreakdown.htfBias === 0) {
      reasons.push('HTF_CONFLICT');
      explanations.push('Execution setup directly opposes Higher Timeframe market structure bias');
    }

    // 4. Session Kill Zone Filter
    if (context.isSessionActive === false) {
      reasons.push('SESSION_FILTER');
      explanations.push('Market outside designated institutional kill zones (illiquid / choppy hours)');
    }

    // 5. High Volatility Regime Shock
    if (context.marketRegime === 'HIGH_VOLATILITY') {
      reasons.push('HIGH_VOLATILITY');
      explanations.push('Market in extreme volatility expansion shock (unfavorable stop loss slip risk)');
    }

    // 6. Drawdown Gate Halted
    if (context.isDrawdownHalted === true) {
      reasons.push('DRAWDOWN_LIMIT');
      explanations.push('Portfolio drawdown circuit breaker active; new trade allocation blocked');
    }

    // 7. Calibrated Expected Value & ML Uncertainty
    const expectedR = context.expectedR ?? (signal.score >= 80 ? 0.8 : signal.score >= 65 ? 0.4 : 0.0);
    if (context.expectedR !== undefined && context.expectedR < minExpectedR) {
      reasons.push('LOW_EXPECTED_VALUE');
      explanations.push(`Calibrated Expected R (${context.expectedR.toFixed(2)}R) below minimum viable cutoff (${minExpectedR}R)`);
    }

    if (context.mlProbability !== undefined && context.mlProbability < 0.50) {
      reasons.push('MODEL_UNCERTAINTY');
      explanations.push(`Machine learning model win probability (${(context.mlProbability * 100).toFixed(1)}%) below 50% threshold`);
    }

    // 8. Correlated Exposure Limit
    if (context.correlatedExposurePercent !== undefined && context.correlatedExposurePercent > 20.0) {
      reasons.push('CORRELATED_EXPOSURE');
      explanations.push(`Correlated directional exposure (${context.correlatedExposurePercent.toFixed(1)}%) exceeds safety ceiling (20%)`);
    }

    const isAllowed = reasons.length === 0;
    const confidence = Number((Math.max(0, signal.score / 100) * (isAllowed ? 1.0 : 0.3)).toFixed(2));

    return {
      decision: isAllowed ? 'ALLOW' : 'BLOCK',
      isAllowed,
      reasons,
      explanation: isAllowed
        ? `Trade Approved: High-conviction ${signal.direction} setup with positive expected value.`
        : `Trade Blocked: [${reasons.join(', ')}] - ${explanations.join('; ')}`,
      confidence,
      riskAdjustedExpectancy: Number(expectedR.toFixed(2)),
    };
  }
}
