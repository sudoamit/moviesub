import { MultiTimeframeAnalyzer } from '../mtf-analyzer';
import { Direction, MTFMode, Timeframe } from '@quant/shared';

describe('MultiTimeframeAnalyzer', () => {
  it('should establish strong bullish alignment when both HTF1 and HTF2 are bullish', () => {
    const execTf = { timeframe: Timeframe.M15, candles: [] };
    const htf1 = {
      timeframe: Timeframe.H1,
      candles: [],
      analysis: {
        candlesCount: 100,
        swingPoints: [],
        confirmedSwingHighs: [],
        confirmedSwingLows: [],
        breaksOfStructure: [],
        changesOfCharacter: [],
        liquidityPools: [],
        liquiditySweeps: [],
        fairValueGaps: [],
        activeFVGs: [],
        orderBlocks: [],
        activeOrderBlocks: [],
        dealingRange: null,
        marketRegime: { regime: 'BULLISH_TREND' as any, atr: 50, adx: 30, volatility: 0.2, timestamp: new Date() },
        currentTrend: Direction.BULLISH,
      },
    };
    const htf2 = {
      timeframe: Timeframe.H4,
      candles: [],
      analysis: {
        candlesCount: 100,
        swingPoints: [],
        confirmedSwingHighs: [],
        confirmedSwingLows: [],
        breaksOfStructure: [],
        changesOfCharacter: [],
        liquidityPools: [],
        liquiditySweeps: [],
        fairValueGaps: [],
        activeFVGs: [],
        orderBlocks: [],
        activeOrderBlocks: [],
        dealingRange: null,
        marketRegime: { regime: 'BULLISH_TREND' as any, atr: 100, adx: 35, volatility: 0.3, timestamp: new Date() },
        currentTrend: Direction.BULLISH,
      },
    };

    const res = MultiTimeframeAnalyzer.analyzeMTF(execTf, htf1, htf2, MTFMode.BALANCED);
    expect(res.htfBias).toBe(Direction.BULLISH);
    expect(res.isAligned).toBe(true);
    expect(res.alignmentScore).toBe(20);
  });
});
