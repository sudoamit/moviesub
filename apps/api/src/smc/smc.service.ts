import { Injectable, Logger } from '@nestjs/common';
import { CandlesService } from '../candles/candles.service';
import { SMCAnalyzer } from '@quant/trading-engine';
import { Timeframe } from '@quant/shared';

@Injectable()
export class SMCService {
  private readonly logger = new Logger(SMCService.name);

  constructor(private readonly candlesService: CandlesService) {}

  async getSMCAnalysis(symbol: string, timeframe: Timeframe = Timeframe.M15, limit = 200) {
    const candlesRes = await this.candlesService.getCandles({
      symbol,
      timeframe,
      limit,
    });

    const candles = candlesRes.candles;
    const closedList = candles.filter((c) => c.isClosed !== false);
    const latestClosedCandle = closedList.length > 0 ? closedList[closedList.length - 1] : candles[candles.length - 1];
    const latestClosedTimestamp = latestClosedCandle ? latestClosedCandle.timestamp : new Date();

    const analysis = SMCAnalyzer.analyze(candles, {
      asOfTimestamp: latestClosedTimestamp,
      timeframe: String(timeframe),
    });

    return {
      symbol: symbol.toUpperCase(),
      timeframe,
      dataProvenance: candlesRes.dataProvenance || 'LIVE',
      closedThrough: latestClosedTimestamp,
      ...analysis,
    };
  }

  async getMarketStructure(symbol: string, timeframe: Timeframe = Timeframe.M15) {
    const analysis = await this.getSMCAnalysis(symbol, timeframe);
    return {
      symbol: analysis.symbol,
      timeframe: analysis.timeframe,
      swingPoints: analysis.swingPoints,
      breaksOfStructure: analysis.breaksOfStructure,
      changesOfCharacter: analysis.changesOfCharacter,
      currentTrend: analysis.currentTrend,
    };
  }

  async getLiquidity(symbol: string, timeframe: Timeframe = Timeframe.M15) {
    const analysis = await this.getSMCAnalysis(symbol, timeframe);
    return {
      symbol: analysis.symbol,
      timeframe: analysis.timeframe,
      liquidityPools: analysis.liquidityPools,
      liquiditySweeps: analysis.liquiditySweeps,
    };
  }

  async getFairValueGaps(symbol: string, timeframe: Timeframe = Timeframe.M15) {
    const analysis = await this.getSMCAnalysis(symbol, timeframe);
    return {
      symbol: analysis.symbol,
      timeframe: analysis.timeframe,
      fairValueGaps: analysis.fairValueGaps,
    };
  }

  async getFVG(symbol: string, timeframe: Timeframe = Timeframe.M15) {
    return this.getFairValueGaps(symbol, timeframe);
  }

  async getOrderBlocks(symbol: string, timeframe: Timeframe = Timeframe.M15) {
    const analysis = await this.getSMCAnalysis(symbol, timeframe);
    return {
      symbol: analysis.symbol,
      timeframe: analysis.timeframe,
      orderBlocks: analysis.orderBlocks,
    };
  }

  async getMarketRegime(symbol: string, timeframe: Timeframe = Timeframe.M15) {
    const analysis = await this.getSMCAnalysis(symbol, timeframe);
    return {
      symbol: analysis.symbol,
      timeframe: analysis.timeframe,
      regime: analysis.marketRegime,
      marketRegime: analysis.marketRegime,
    };
  }
}
