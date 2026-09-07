import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  SessionFilter,
  SMTDivergenceEngine,
  MTFFlowRadarEngine,
  TrailingEngine,
  LiquidityHeatmapEngine,
  ISessionInfo,
  ISMTDivergenceResult,
  IMTFFlowRadarResult,
  ILiquidityHeatmapResult,
  IDynamicTrailingState,
} from '@quant/trading-engine';
import { Timeframe, ICandle } from '@quant/shared';

@Injectable()
export class AccuracyService {
  private readonly logger = new Logger(AccuracyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 1. Get Live Active ICT Session & Kill Zone Info
   */
  getSessionInfo(symbol: string = 'NIFTY'): ISessionInfo {
    return SessionFilter.getSessionInfo(new Date(), symbol);
  }

  /**
   * Helper to fetch parsed candles for an instrument
   */
  private async getCandlesForInstrument(
    symbol: string,
    timeframe: string,
    limit: number = 60,
  ): Promise<ICandle[]> {
    const inst = await this.prisma.instrument.findUnique({
      where: { symbol: symbol.toUpperCase() },
    });
    if (!inst) return [];

    const rows = await this.prisma.candle.findMany({
      where: { instrumentId: inst.id, timeframe: timeframe as any },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    return rows.reverse().map((r) => ({
      timestamp: r.timestamp,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume || 1),
      isClosed: true,
    }));
  }

  /**
   * 2. SMT (Smart Money Technique) Correlation Divergence Engine
   */
  async getSMTDivergence(
    assetA: string = 'NIFTY',
    assetB: string = 'BANKNIFTY',
    timeframe: string = 'M15',
  ): Promise<ISMTDivergenceResult> {
    const [candlesA, candlesB] = await Promise.all([
      this.getCandlesForInstrument(assetA, timeframe, 50),
      this.getCandlesForInstrument(assetB, timeframe, 50),
    ]);

    return SMTDivergenceEngine.analyze(assetA, candlesA, assetB, candlesB, 35);
  }

  /**
   * 2b. Multi-Timeframe SMT Divergence Heatmap Matrix (1m -> 5m -> 15m -> 1h -> 4h -> 1d)
   */
  async getSMTMultiTimeframe(assetA: string = 'NIFTY', assetB: string = 'BANKNIFTY') {
    const timeframes = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];
    const results = await Promise.all(
      timeframes.map(async (tf) => {
        const [candlesA, candlesB] = await Promise.all([
          this.getCandlesForInstrument(assetA, tf, 50),
          this.getCandlesForInstrument(assetB, tf, 50),
        ]);
        const res = SMTDivergenceEngine.analyze(assetA, candlesA, assetB, candlesB, 35);
        return {
          timeframe: tf,
          ...res,
        };
      }),
    );

    const activeDivergences = results.filter((r) => r.divergenceType !== 'NEUTRAL');
    const primaryDivergence =
      results.find((r) => r.timeframe === 'M15') || results[2] || results[0];

    return {
      assetA,
      assetB,
      primary: primaryDivergence,
      divergenceConfluenceCount: activeDivergences.length,
      timeframeResults: results,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 3. Multi-Timeframe 4-Tier Order Flow Confluence Radar (4h -> 1h -> 15m -> 5m)
   */
  async getMTFFlowRadar(symbol: string = 'NIFTY'): Promise<IMTFFlowRadarResult> {
    const [c4h, c1h, c15m, c5m] = await Promise.all([
      this.getCandlesForInstrument(symbol, 'H4', 40),
      this.getCandlesForInstrument(symbol, 'H1', 40),
      this.getCandlesForInstrument(symbol, 'M15', 40),
      this.getCandlesForInstrument(symbol, 'M5', 40),
    ]);

    return MTFFlowRadarEngine.analyze(symbol, c4h, c1h, c15m, c5m);
  }

  /**
   * 4. Dynamic Breakeven & Auto-Trailing Stop Engine
   */
  getDynamicTrailingState(
    entryPrice: number,
    stopLoss: number,
    tp1: number,
    tp2: number,
    currentPrice: number,
    direction: 'BULLISH' | 'BEARISH' = 'BULLISH',
    atr: number = 25,
  ): IDynamicTrailingState {
    return TrailingEngine.evaluate(entryPrice, stopLoss, tp1, tp2, currentPrice, direction, atr);
  }

  /**
   * 5. Institutional Liquidity Heatmap
   */
  async getLiquidityHeatmap(symbol: string = 'NIFTY'): Promise<ILiquidityHeatmapResult> {
    const candles = await this.getCandlesForInstrument(symbol, 'M15', 80);
    return LiquidityHeatmapEngine.compute(candles);
  }
}
