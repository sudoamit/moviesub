export type TradeManagementStage = 'STAGE_1_INITIAL' | 'STAGE_2_BREAKEVEN' | 'STAGE_3_TRAILING';

export interface IDynamicTrailingState {
  stage: TradeManagementStage;
  stageBadge: string;
  currentStopLoss: number;
  isRiskFree: boolean;
  partialBookedPercent: number; // 0, 50, or 100
  profitLockedAmount: number;
  recommendedAction: string;
  trailingStepPrice: number;
}

export class TrailingEngine {
  /**
   * Evaluates real-time position price action against TP milestones and updates Stop Loss dynamically
   */
  static evaluate(
    entryPrice: number,
    initialStopLoss: number,
    tp1Price: number,
    tp2Price: number,
    currentPrice: number,
    direction: 'BULLISH' | 'BEARISH' = 'BULLISH',
    atr: number = 25,
  ): IDynamicTrailingState {
    const isBull = direction === 'BULLISH';
    const buffer = entryPrice * 0.0005; // 0.05% safety cushion for fees/slippage

    // Check if TP2 is reached -> Stage 3 (Trailing Runner)
    const hasReachedTP2 = isBull ? currentPrice >= tp2Price : currentPrice <= tp2Price;
    if (hasReachedTP2) {
      // Trail SL at 1.5x ATR behind current peak price
      const trailingSL = isBull
        ? Number(Math.max(tp1Price, currentPrice - atr * 1.5).toFixed(2))
        : Number(Math.min(tp1Price, currentPrice + atr * 1.5).toFixed(2));

      return {
        stage: 'STAGE_3_TRAILING',
        stageBadge: '🚀 STAGE 3: ATR TRAILING RUNNER',
        currentStopLoss: trailingSL,
        isRiskFree: true,
        partialBookedPercent: 50,
        profitLockedAmount: Math.abs(tp1Price - entryPrice),
        recommendedAction: `Lock in massive 1:2.5+ gains. Trailing 50% runner at ₹${trailingSL}.`,
        trailingStepPrice: trailingSL,
      };
    }

    // Check if TP1 is reached -> Stage 2 (Risk-Free Breakeven)
    const hasReachedTP1 = isBull ? currentPrice >= tp1Price : currentPrice <= tp1Price;
    if (hasReachedTP1) {
      const beStopLoss = isBull
        ? Number((entryPrice + buffer).toFixed(2))
        : Number((entryPrice - buffer).toFixed(2));

      return {
        stage: 'STAGE_2_BREAKEVEN',
        stageBadge: '🛡️ STAGE 2: RISK-FREE BREAKEVEN',
        currentStopLoss: beStopLoss,
        isRiskFree: true,
        partialBookedPercent: 50,
        profitLockedAmount: Math.abs(tp1Price - entryPrice) * 0.5,
        recommendedAction: `50% Partial Profits booked at TP1. Stop Loss moved to Breakeven (₹${beStopLoss}). Risk is 0.00.`,
        trailingStepPrice: beStopLoss,
      };
    }

    // Stage 1: Initial Risk Active
    return {
      stage: 'STAGE_1_INITIAL',
      stageBadge: '🎯 STAGE 1: ACTIVE SETUP',
      currentStopLoss: initialStopLoss,
      isRiskFree: false,
      partialBookedPercent: 0,
      profitLockedAmount: 0,
      recommendedAction: `Initial trade active. SL anchored at structural floor (₹${initialStopLoss.toFixed(2)}).`,
      trailingStepPrice: initialStopLoss,
    };
  }
}
