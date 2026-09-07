import { ICandle, ISwingPoint, StructureType } from '@quant/shared';
import { SwingDetector } from './swing-detector';

export type SMTType = 'BULLISH_SMT' | 'BEARISH_SMT' | 'NEUTRAL';

export interface ISMTDivergenceResult {
  assetA: string;
  assetB: string;
  divergenceType: SMTType;
  convictionScore: number; // 0 - 100
  assetASwing: {
    type: 'HIGH' | 'LOW';
    price1: number;
    price2: number;
    trend: 'HH' | 'LH' | 'LL' | 'HL';
  };
  assetBSwing: {
    type: 'HIGH' | 'LOW';
    price1: number;
    price2: number;
    trend: 'HH' | 'LH' | 'LL' | 'HL';
  };
  narrative: string;
  actionableSignal: 'STRONG_BUY' | 'STRONG_SELL' | 'NO_DIVERGENCE';
  timestamp: string;
}

export class SMTDivergenceEngine {
  /**
   * Detects Smart Money Technique (SMT) Correlation Divergence between two correlated assets
   */
  static analyze(
    assetASymbol: string,
    candlesA: ICandle[],
    assetBSymbol: string,
    candlesB: ICandle[],
    lookback: number = 35,
  ): ISMTDivergenceResult {
    if (!candlesA || candlesA.length < 10 || !candlesB || candlesB.length < 10) {
      return {
        assetA: assetASymbol,
        assetB: assetBSymbol,
        divergenceType: 'NEUTRAL',
        convictionScore: 0,
        assetASwing: { type: 'HIGH', price1: 0, price2: 0, trend: 'HH' },
        assetBSwing: { type: 'HIGH', price1: 0, price2: 0, trend: 'HH' },
        narrative: 'Insufficient candle data for SMT correlation divergence analysis',
        actionableSignal: 'NO_DIVERGENCE',
        timestamp: new Date().toISOString(),
      };
    }

    const recentA = candlesA.slice(-lookback);
    const recentB = candlesB.slice(-lookback);

    const swingsA = SwingDetector.detectSwings(recentA, { leftBars: 3, rightBars: 3 });
    const swingsB = SwingDetector.detectSwings(recentB, { leftBars: 3, rightBars: 3 });

    const highsA: ISwingPoint[] = swingsA.filter(
      (s: ISwingPoint) =>
        s.type === StructureType.SWING_HIGH ||
        s.type === StructureType.HIGHER_HIGH ||
        s.type === StructureType.LOWER_HIGH,
    );
    const lowsA: ISwingPoint[] = swingsA.filter(
      (s: ISwingPoint) =>
        s.type === StructureType.SWING_LOW ||
        s.type === StructureType.HIGHER_LOW ||
        s.type === StructureType.LOWER_LOW,
    );
    const highsB: ISwingPoint[] = swingsB.filter(
      (s: ISwingPoint) =>
        s.type === StructureType.SWING_HIGH ||
        s.type === StructureType.HIGHER_HIGH ||
        s.type === StructureType.LOWER_HIGH,
    );
    const lowsB: ISwingPoint[] = swingsB.filter(
      (s: ISwingPoint) =>
        s.type === StructureType.SWING_LOW ||
        s.type === StructureType.HIGHER_LOW ||
        s.type === StructureType.LOWER_LOW,
    );

    // 1. Check for Bearish SMT (Distribution) on recent 2 swing highs
    if (highsA.length >= 2 && highsB.length >= 2) {
      const aPrev = highsA[highsA.length - 2].price;
      const aCurr = highsA[highsA.length - 1].price;
      const bPrev = highsB[highsB.length - 2].price;
      const bCurr = highsB[highsB.length - 1].price;

      const aIsHH = aCurr > aPrev;
      const bIsLH = bCurr < bPrev;

      const aIsLH = aCurr < aPrev;
      const bIsHH = bCurr > bPrev;

      if ((aIsHH && bIsLH) || (aIsLH && bIsHH)) {
        const leader = aIsHH ? assetASymbol : assetBSymbol;
        const laggard = aIsHH ? assetBSymbol : assetASymbol;
        return {
          assetA: assetASymbol,
          assetB: assetBSymbol,
          divergenceType: 'BEARISH_SMT',
          convictionScore: 92,
          assetASwing: { type: 'HIGH', price1: aPrev, price2: aCurr, trend: aIsHH ? 'HH' : 'LH' },
          assetBSwing: { type: 'HIGH', price1: bPrev, price2: bCurr, trend: bIsHH ? 'HH' : 'LH' },
          narrative: `🔥 High-Conviction BEARISH SMT Distribution: ${leader} printed a Higher High but ${laggard} failed with a Lower High. Smart Money is aggressively distributing before a major downside expansion.`,
          actionableSignal: 'STRONG_SELL',
          timestamp: new Date().toISOString(),
        };
      }
    }

    // 2. Check for Bullish SMT (Accumulation) on recent 2 swing lows
    if (lowsA.length >= 2 && lowsB.length >= 2) {
      const aPrev = lowsA[lowsA.length - 2].price;
      const aCurr = lowsA[lowsA.length - 1].price;
      const bPrev = lowsB[lowsB.length - 2].price;
      const bCurr = lowsB[lowsB.length - 1].price;

      const aIsLL = aCurr < aPrev;
      const bIsHL = bCurr > bPrev;

      const aIsHL = aCurr > aPrev;
      const bIsLL = bCurr < bPrev;

      if ((aIsLL && bIsHL) || (aIsHL && bIsLL)) {
        const leader = aIsLL ? assetASymbol : assetBSymbol;
        const laggard = aIsLL ? assetBSymbol : assetASymbol;
        return {
          assetA: assetASymbol,
          assetB: assetBSymbol,
          divergenceType: 'BULLISH_SMT',
          convictionScore: 90,
          assetASwing: { type: 'LOW', price1: aPrev, price2: aCurr, trend: aIsLL ? 'LL' : 'HL' },
          assetBSwing: { type: 'LOW', price1: bPrev, price2: bCurr, trend: bIsHL ? 'HL' : 'LL' },
          narrative: `⚡ High-Conviction BULLISH SMT Accumulation: ${leader} swept liquidity to a Lower Low while ${laggard} held strong with a Higher Low. Institutional absorption confirmed.`,
          actionableSignal: 'STRONG_BUY',
          timestamp: new Date().toISOString(),
        };
      }
    }

    // Neutral baseline
    return {
      assetA: assetASymbol,
      assetB: assetBSymbol,
      divergenceType: 'NEUTRAL',
      convictionScore: 50,
      assetASwing: { type: 'HIGH', price1: 0, price2: 0, trend: 'HH' },
      assetBSwing: { type: 'HIGH', price1: 0, price2: 0, trend: 'HH' },
      narrative: `Both ${assetASymbol} and ${assetBSymbol} are in synchronized correlation with no institutional lead-lag divergence.`,
      actionableSignal: 'NO_DIVERGENCE',
      timestamp: new Date().toISOString(),
    };
  }
}
