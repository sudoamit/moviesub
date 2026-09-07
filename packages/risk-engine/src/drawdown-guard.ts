export interface IDrawdownStatus {
  currentEquity: number;
  peakEquity: number;
  startingDayEquity: number;
  totalDrawdownAmount: number;
  totalDrawdownPercent: number;
  dailyDrawdownAmount: number;
  dailyDrawdownPercent: number;
  isTradingHalted: boolean;
  riskReductionMultiplier: number;
  warningMessage?: string;
}

export interface IDrawdownGuardOptions {
  maxAccountDrawdownPercent?: number; // e.g. 10%
  maxDailyDrawdownPercent?: number; // e.g. 5%
}

export class DrawdownGuard {
  /**
   * Evaluates equity curve and drawdown limits to protect capital
   */
  static evaluateDrawdown(
    currentEquity: number,
    peakEquity: number,
    startingDayEquity: number,
    options: IDrawdownGuardOptions = {},
  ): IDrawdownStatus {
    const maxAccountDD = options.maxAccountDrawdownPercent ?? 10.0;
    const maxDailyDD = options.maxDailyDrawdownPercent ?? 5.0;

    const safePeak = Math.max(peakEquity, currentEquity, 1);
    const safeDayStart = Math.max(startingDayEquity, 1);

    const totalDrawdownAmount = Math.max(0, safePeak - currentEquity);
    const totalDrawdownPercent = (totalDrawdownAmount / safePeak) * 100;

    const dailyDrawdownAmount = Math.max(0, safeDayStart - currentEquity);
    const dailyDrawdownPercent = (dailyDrawdownAmount / safeDayStart) * 100;

    let isTradingHalted = false;
    let riskReductionMultiplier = 1.0;
    let warningMessage: string | undefined = undefined;

    if (totalDrawdownPercent >= maxAccountDD) {
      isTradingHalted = true;
      warningMessage = `CRITICAL: Maximum account drawdown breached (${totalDrawdownPercent.toFixed(2)}% >= ${maxAccountDD}%). Trading is halted.`;
    } else if (dailyDrawdownPercent >= maxDailyDD) {
      isTradingHalted = true;
      warningMessage = `CRITICAL: Maximum daily drawdown breached (${dailyDrawdownPercent.toFixed(2)}% >= ${maxDailyDD}%). Trading is halted for today.`;
    } else if (
      dailyDrawdownPercent >= maxDailyDD * 0.7 ||
      totalDrawdownPercent >= maxAccountDD * 0.7
    ) {
      riskReductionMultiplier = 0.5; // Cut risk by 50%
      warningMessage = `WARNING: Approaching drawdown limits. Risk per trade is automatically reduced by 50%.`;
    }

    return {
      currentEquity,
      peakEquity: safePeak,
      startingDayEquity: safeDayStart,
      totalDrawdownAmount: Number(totalDrawdownAmount.toFixed(2)),
      totalDrawdownPercent: Number(totalDrawdownPercent.toFixed(2)),
      dailyDrawdownAmount: Number(dailyDrawdownAmount.toFixed(2)),
      dailyDrawdownPercent: Number(dailyDrawdownPercent.toFixed(2)),
      isTradingHalted,
      riskReductionMultiplier,
      warningMessage,
    };
  }
}
