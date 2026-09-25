export interface ResolveOptionLevelsParams {
  optionEntryPrice: number;
  slPercent?: number; // e.g. 30 for 30% stop loss below premium. Default 30.
  tp1Ratio?: number;  // Default 1.5 (1.5R)
  tp2Ratio?: number;  // Default 2.5 (2.5R)
  tp3Ratio?: number;  // Default 4.0 (4.0R)
}

export interface ResolvedOptionLevels {
  optimalEntry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  target3: number;
  riskPerUnit: number;
  rr1: number;
  rr2: number;
  rr3: number;
  maxPotentialR: number;
}

export class OptionTradeLevelsResolver {
  /**
   * Resolves options trade levels (Entry, SL, TP1, TP2, TP3) strictly on the option premium scale.
   * Options are always bought (orderSide = BUY), so:
   * 0 < stopLoss < optimalEntry < target1 < target2 < target3.
   */
  static resolveLevels(params: ResolveOptionLevelsParams): ResolvedOptionLevels {
    const entry = Number(params.optionEntryPrice);
    if (!Number.isFinite(entry) || entry <= 0) {
      throw new Error(`Invalid option entry price: ${params.optionEntryPrice}. Must be a positive number.`);
    }

    const slPercent = params.slPercent && params.slPercent > 0 && params.slPercent < 100
      ? params.slPercent
      : 30;

    const riskPerUnit = Math.round(entry * (slPercent / 100) * 100) / 100;
    
    // Stop loss strictly below entry
    let stopLoss = Math.round((entry - riskPerUnit) * 100) / 100;
    if (stopLoss <= 0) {
      stopLoss = Math.round(entry * 0.5 * 100) / 100;
      if (stopLoss <= 0) {
        stopLoss = 0.05;
      }
    }

    const tp1Multiplier = params.tp1Ratio && params.tp1Ratio > 0 ? params.tp1Ratio : 1.5;
    const tp2Multiplier = params.tp2Ratio && params.tp2Ratio > tp1Multiplier ? params.tp2Ratio : 2.5;
    const tp3Multiplier = params.tp3Ratio && params.tp3Ratio > tp2Multiplier ? params.tp3Ratio : 4.0;

    const target1 = Math.round((entry + riskPerUnit * tp1Multiplier) * 100) / 100;
    const target2 = Math.round((entry + riskPerUnit * tp2Multiplier) * 100) / 100;
    const target3 = Math.round((entry + riskPerUnit * tp3Multiplier) * 100) / 100;

    // Strict invariant check
    if (!(stopLoss < entry && entry < target1 && target1 < target2 && target2 < target3)) {
      throw new Error(
        `Invalid option trade levels generated: SL=${stopLoss}, Entry=${entry}, TP1=${target1}, TP2=${target2}, TP3=${target3}`
      );
    }

    return {
      optimalEntry: entry,
      stopLoss,
      target1,
      target2,
      target3,
      riskPerUnit,
      rr1: tp1Multiplier,
      rr2: tp2Multiplier,
      rr3: tp3Multiplier,
      maxPotentialR: tp3Multiplier,
    };
  }
}
