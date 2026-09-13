import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { MarketDataService } from '../market-data/market-data.service';
import { ICandle, REDIS_KEYS, Timeframe, toPrismaTimeframe } from '@quant/shared';
import {
  calculateEMA,
  calculateSMA,
  calculateVWAP,
  calculateRSI,
  calculateATR,
  calculateBollingerBands,
} from '@quant/indicators';
import { SMCAnalyzer, SignalGenerator } from '@quant/trading-engine';
import { GetCandlesDto, IngestCandlesDto } from './dto/get-candles.dto';

export interface ICandlesResponse {
  symbol: string;
  timeframe: string;
  count: number;
  candles: ICandle[];
  dataProvenance?: import('@quant/shared').DataProvenance;
}

export interface IChartDataResponse {
  instrument: {
    symbol: string;
    name: string;
    currency: string;
    tickSize: number;
  };
  timeframe: string;
  dataProvenance?: import('@quant/shared').DataProvenance;
  closedThrough?: Date;
  isDegraded?: boolean;
  candles: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    isClosed?: boolean;
  }>;
  indicators: {
    ema20: Array<{ time: number; value: number }>;
    ema50: Array<{ time: number; value: number }>;
    ema200: Array<{ time: number; value: number }>;
    sma20: Array<{ time: number; value: number }>;
    vwap: Array<{ time: number; value: number }>;
    rsi14: Array<{ time: number; value: number }>;
    atr14: Array<{ time: number; value: number }>;
    bollinger: Array<{ time: number; upper: number; middle: number; lower: number }>;
  };
  structures: {
    swings: any[];
    bos: any[];
    choch: any[];
    marketRegime: any;
    dealingRange: any;
  };
  liquidity: {
    pools: any[];
    sweeps: any[];
  };
  fvgs: any[];
  orderBlocks: any[];
  activeSignal: any | null;
}

@Injectable()
export class CandlesService {
  private readonly logger = new Logger(CandlesService.name);
  private candleCache: Map<string, { timestamp: number; candles: ICandle[] }> = new Map();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly marketDataService: MarketDataService,
  ) {}

  /**
   * Fetches real live exchange candlestick history (Yahoo Finance for NSE, Binance for Crypto)
   */
  private async fetchRealExchangeCandles(
    symbol: string,
    timeframe: string,
    limit = 200,
  ): Promise<ICandle[]> {
    const sym = symbol.toUpperCase();
    const cacheKey = `${sym}_${timeframe}`;
    const cached = this.candleCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 3000) {
      return cached.candles;
    }

    try {
      const normTf = (timeframe || '15m').toUpperCase().replace('MIN', 'M').replace('MINUTES', 'M');
      const is1m = normTf === 'M1' || normTf === '1M';
      const is5m = normTf === 'M5' || normTf === '5M';
      const is15m = normTf === 'M15' || normTf === '15M' || normTf === '15';
      const is1h = normTf === 'H1' || normTf === '1H' || normTf === '60M' || normTf === '60';
      const is4h = normTf === 'H4' || normTf === '4H' || normTf === '240M' || normTf === '240';

      if (sym === 'BTCUSDT' || sym === 'XAUUSD' || sym === 'GOLD' || sym === 'PAXGUSDT') {
        const binanceInterval = is1m
          ? '1m'
          : is5m
            ? '5m'
            : is15m
              ? '15m'
              : is1h
                ? '1h'
                : is4h
                  ? '4h'
                  : '1d';
        const binancePair = sym === 'XAUUSD' || sym === 'GOLD' ? 'PAXGUSDT' : 'BTCUSDT';

        const res = await fetch(
          `https://api.binance.com/api/v3/klines?symbol=${binancePair}&interval=${binanceInterval}&limit=${limit}`,
        );
        if (res.ok) {
          const data = await res.json();
          const candles: ICandle[] = data.map((d: any, idx: number) => ({
            timestamp: new Date(d[0]),
            open: Number(parseFloat(d[1]).toFixed(2)),
            high: Number(parseFloat(d[2]).toFixed(2)),
            low: Number(parseFloat(d[3]).toFixed(2)),
            close: Number(parseFloat(d[4]).toFixed(2)),
            volume: Number(parseFloat(d[5]).toFixed(2)),
            isClosed: idx < data.length - 1,
          }));
          this.candleCache.set(cacheKey, { timestamp: Date.now(), candles });
          return candles;
        }
      } else {
        const symbolMap: Record<string, string> = {
          NIFTY: '^NSEI',
          BANKNIFTY: '^NSEBANK',
          XAUUSD: 'GC=F',
          GOLD: 'GC=F',
          RELIANCE: 'RELIANCE.NS',
          HDFCBANK: 'HDFCBANK.NS',
          INFY: 'INFY.NS',
        };
        const ysym = symbolMap[sym] || `${sym}.NS`;
        const yInterval = is1m ? '1m' : is5m ? '5m' : is15m ? '15m' : is1h || is4h ? '60m' : '1d';
        const yRange = is1m ? '1d' : is5m || is15m ? '5d' : is1h || is4h ? '1mo' : '1y';

        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym)}?interval=${yInterval}&range=${yRange}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (res.ok) {
          const data = await res.json();
          const result = data?.chart?.result?.[0];
          const timestamps = result?.timestamp || [];
          const quote = result?.indicators?.quote?.[0] || {};
          const candles: ICandle[] = [];

          for (let i = 0; i < timestamps.length; i++) {
            const o = quote.open?.[i];
            const h = quote.high?.[i];
            const l = quote.low?.[i];
            const c = quote.close?.[i];
            const v = quote.volume?.[i] || 0;
            if (o !== null && h !== null && l !== null && c !== null && !isNaN(o) && !isNaN(c)) {
              candles.push({
                timestamp: new Date(timestamps[i] * 1000),
                open: Number(o.toFixed(2)),
                high: Number(h.toFixed(2)),
                low: Number(l.toFixed(2)),
                close: Number(c.toFixed(2)),
                volume: v,
                isClosed: i < timestamps.length - 1,
              });
            }
          }

          if (candles.length > 0) {
            const sliced = candles.slice(-limit);
            this.candleCache.set(cacheKey, { timestamp: Date.now(), candles: sliced });
            return sliced;
          }
        }
      }
    } catch (err) {
      this.logger.debug(`Live exchange candle fetch notice for ${sym}: ${(err as Error).message}`);
    }

    return cached?.candles || [];
  }

  async getCandles(query: GetCandlesDto): Promise<ICandlesResponse> {
    const symbol = query.symbol.toUpperCase();
    const timeframe = query.timeframe || Timeframe.M15;
    const limit = query.limit || 100;
    const prismaTf = toPrismaTimeframe(timeframe);

    // 1. Try real live exchange candles first
    if (!query.from && !query.to) {
      const liveCandles = await this.fetchRealExchangeCandles(symbol, timeframe as string, limit);
      if (liveCandles.length > 0) {
        return {
          symbol,
          timeframe,
          count: liveCandles.length,
          candles: liveCandles,
          dataProvenance: 'LIVE',
        };
      }
    }

    const inst = await this.prisma.instrument.findUnique({
      where: { symbol },
    });

    if (!inst) {
      throw new NotFoundException(`Instrument with symbol '${symbol}' not found`);
    }

    const whereClause: any = {
      instrumentId: inst.id,
      timeframe: prismaTf,
    };

    if (query.from || query.to) {
      whereClause.timestamp = {};
      if (query.from) {
        whereClause.timestamp.gte = new Date(query.from);
      }
      if (query.to) {
        whereClause.timestamp.lte = new Date(query.to);
      }
    }

    const dbCandles = await this.prisma.candle.findMany({
      where: whereClause,
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    const candles: ICandle[] = dbCandles.reverse().map((c) => ({
      timestamp: c.timestamp,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
      isClosed: c.isClosed,
      provenance: 'DELAYED',
    }));

    return {
      symbol,
      timeframe,
      count: candles.length,
      candles,
      dataProvenance: 'DELAYED',
    };
  }

  async getChartData(
    symbol: string,
    timeframe: Timeframe = Timeframe.M15,
    limit = 200,
  ): Promise<IChartDataResponse> {
    const sym = symbol.toUpperCase();
    const inst = await this.prisma.instrument.findUnique({
      where: { symbol: sym },
    });

    if (!inst) {
      throw new NotFoundException(`Instrument with symbol '${sym}' not found`);
    }

    // Always fetch live candles for full structural context
    const candlesResp = await this.getCandles({
      symbol: sym,
      timeframe,
      limit: Math.max(limit, 200),
    });
    const candles = candlesResp.candles;

    if (candles.length === 0) {
      throw new NotFoundException(`No candles found for '${sym}' on timeframe '${timeframe}'`);
    }

    const closePrices = candles.map((c) => c.close);

    // 1. Calculate Technical Indicators Series
    const ema20Raw = calculateEMA(closePrices, 20);
    const ema50Raw = calculateEMA(closePrices, 50);
    const ema200Raw = calculateEMA(closePrices, 200);
    const sma20Raw = calculateSMA(closePrices, 20);
    const vwapRaw = calculateVWAP(candles);
    const rsi14Raw = calculateRSI(candles, 14);
    const atr14Raw = calculateATR(candles, 14);
    const bbRaw = calculateBollingerBands(candles, 20, 2);

    const formattedCandles = candles.map((c) => ({
      time: Math.floor(new Date(c.timestamp).getTime() / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      isClosed: c.isClosed,
    }));

    const buildSeries = (series: (number | null)[]) =>
      candles
        .map((c, i) => {
          const val = series[i];
          return {
            time: Math.floor(new Date(c.timestamp).getTime() / 1000),
            value: val !== null && val !== undefined && !isNaN(val) ? Number(val.toFixed(2)) : null,
          };
        })
        .filter((item): item is { time: number; value: number } => item.value !== null);

    const ema20 = buildSeries(ema20Raw);
    const ema50 = buildSeries(ema50Raw);
    const ema200 = buildSeries(ema200Raw);
    const sma20 = buildSeries(sma20Raw);
    const vwap = buildSeries(vwapRaw);
    const rsi14 = buildSeries(rsi14Raw);
    const atr14 = buildSeries(atr14Raw);

    const bollinger = candles
      .map((c, i) => {
        const up = bbRaw.upper[i];
        const mid = bbRaw.middle[i];
        const low = bbRaw.lower[i];
        if (up === null || mid === null || low === null || isNaN(up) || isNaN(low)) return null;
        return {
          time: Math.floor(new Date(c.timestamp).getTime() / 1000),
          upper: Number(up.toFixed(2)),
          middle: Number(mid.toFixed(2)),
          lower: Number(low.toFixed(2)),
        };
      })
      .filter(
        (item): item is { time: number; upper: number; middle: number; lower: number } =>
          item !== null,
      );

    // 2. Pure SMC Analysis from trading-engine with explicit latest closed candle boundary
    const closedCandlesList = candles.filter((c) => c.isClosed !== false);
    const latestClosedCandle = closedCandlesList.length > 0 ? closedCandlesList[closedCandlesList.length - 1] : candles[candles.length - 1];
    const latestClosedTimestamp = latestClosedCandle.timestamp;

    const smcAnalysis = SMCAnalyzer.analyze(candles, {
      asOfTimestamp: latestClosedTimestamp,
      timeframe,
    });

    // 3. Multi-Timeframe Signal Setup Generation (100% matched with SignalsService)
    let activeSignal: any = null;
    try {
      const [htf1, htf2] = await Promise.all([
        this.getCandles({ symbol: sym, timeframe: Timeframe.H1, limit: 150 }).catch(() => ({
          candles: [],
        })),
        this.getCandles({ symbol: sym, timeframe: Timeframe.H4, limit: 100 }).catch(() => ({
          candles: [],
        })),
      ]);

      activeSignal = SignalGenerator.generateSignal({
        symbol: sym,
        executionCandles: candles,
        executionTimeframe: timeframe,
        htf1Candles: htf1.candles,
        htf1Timeframe: Timeframe.H1,
        htf2Candles: htf2.candles,
        htf2Timeframe: Timeframe.H4,
      });
      activeSignal.instrumentId = inst.id;
    } catch (e) {
      this.logger.debug(`Signal generation: ${(e as Error).message}`);
    }

    return {
      instrument: {
        symbol: inst.symbol,
        name: inst.name,
        currency: inst.currency,
        tickSize: Number(inst.tickSize),
      },
      timeframe,
      dataProvenance: candlesResp.dataProvenance || 'LIVE',
      closedThrough: latestClosedTimestamp,
      isDegraded: smcAnalysis.isDegraded || false,
      candles: formattedCandles,
      indicators: {
        ema20,
        ema50,
        ema200,
        sma20,
        vwap,
        rsi14,
        atr14,
        bollinger,
      },
      structures: {
        swings: smcAnalysis.swingPoints || [],
        bos: smcAnalysis.breaksOfStructure || [],
        choch: smcAnalysis.changesOfCharacter || [],
        marketRegime: smcAnalysis.marketRegime,
        dealingRange: smcAnalysis.dealingRange,
      },
      liquidity: {
        pools: smcAnalysis.liquidityPools || [],
        sweeps: smcAnalysis.liquiditySweeps || [],
      },
      fvgs: smcAnalysis.fairValueGaps || [],
      orderBlocks: smcAnalysis.orderBlocks || [],
      activeSignal,
    };
  }

  async getLatestCandle(symbol: string, timeframe: Timeframe | string): Promise<ICandle> {
    const sym = symbol.toUpperCase();
    const liveCandles = await this.fetchRealExchangeCandles(sym, timeframe as string, 1);
    if (liveCandles.length > 0) {
      return liveCandles[liveCandles.length - 1];
    }

    const redisKey = REDIS_KEYS.LATEST_CANDLE(sym, timeframe as string);
    const cached = await this.redis.get(redisKey);

    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        return {
          ...parsed,
          timestamp: new Date(parsed.timestamp),
        };
      } catch (e) {
        // Fallback to database
      }
    }

    const inst = await this.prisma.instrument.findUnique({
      where: { symbol: sym },
    });

    if (!inst) {
      throw new NotFoundException(`Instrument with symbol '${sym}' not found`);
    }

    const prismaTf = toPrismaTimeframe(timeframe);

    const candle = await this.prisma.candle.findFirst({
      where: {
        instrumentId: inst.id,
        timeframe: prismaTf,
      },
      orderBy: { timestamp: 'desc' },
    });

    if (!candle) {
      throw new NotFoundException(`No candles found for '${sym}' on timeframe '${timeframe}'`);
    }

    return {
      timestamp: candle.timestamp,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume),
      isClosed: candle.isClosed,
    };
  }

  async ingestCandles(dto: IngestCandlesDto) {
    return this.marketDataService.backfillHistoricalCandles(dto.symbol, dto.timeframe, dto.limit);
  }
}
