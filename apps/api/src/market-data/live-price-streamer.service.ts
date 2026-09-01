import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { WS_EVENTS } from '@quant/shared';

interface IAssetTicker {
  symbol: string;
  price: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  prevClose: number;
  tickSize: number;
  volatility: number;
  candleStartTime: number;
}

@Injectable()
export class LivePriceStreamerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LivePriceStreamerService.name);
  private timer: NodeJS.Timeout | null = null;

  private tickers: Map<string, IAssetTicker> = new Map([
    [
      'NIFTY',
      {
        symbol: 'NIFTY',
        price: 24175.0,
        open: 24160.0,
        high: 24215.0,
        low: 24135.0,
        close: 24175.0,
        volume: 1250000,
        prevClose: 24148.0,
        tickSize: 0.05,
        volatility: 1.2,
        candleStartTime: Date.now(),
      },
    ],
    [
      'BANKNIFTY',
      {
        symbol: 'BANKNIFTY',
        price: 51240.0,
        open: 51150.0,
        high: 51450.0,
        low: 50980.0,
        close: 51240.0,
        volume: 850000,
        prevClose: 51120.0,
        tickSize: 0.05,
        volatility: 4.5,
        candleStartTime: Date.now(),
      },
    ],
    [
      'BTCUSDT',
      {
        symbol: 'BTCUSDT',
        price: 89480.0,
        open: 89200.0,
        high: 89850.0,
        low: 89100.0,
        close: 89480.0,
        volume: 45000,
        prevClose: 88900.0,
        tickSize: 0.1,
        volatility: 12.0,
        candleStartTime: Date.now(),
      },
    ],
    [
      'RELIANCE',
      {
        symbol: 'RELIANCE',
        price: 3022.5,
        open: 3010.0,
        high: 3045.0,
        low: 3005.0,
        close: 3022.5,
        volume: 320000,
        prevClose: 3012.0,
        tickSize: 0.05,
        volatility: 0.6,
        candleStartTime: Date.now(),
      },
    ],
    [
      'HDFCBANK',
      {
        symbol: 'HDFCBANK',
        price: 1648.5,
        open: 1642.0,
        high: 1655.0,
        low: 1638.0,
        close: 1648.5,
        volume: 450000,
        prevClose: 1644.0,
        tickSize: 0.05,
        volatility: 0.35,
        candleStartTime: Date.now(),
      },
    ],
    [
      'INFY',
      {
        symbol: 'INFY',
        price: 1892.4,
        open: 1885.0,
        high: 1905.0,
        low: 1878.0,
        close: 1892.4,
        volume: 280000,
        prevClose: 1886.0,
        tickSize: 0.05,
        volatility: 0.45,
        candleStartTime: Date.now(),
      },
    ],
  ]);

  constructor(private readonly redis: RedisService) {}

  onModuleInit() {
    this.startStreaming();
  }

  startStreaming() {
    if (this.timer) clearInterval(this.timer);

    this.logger.log('Starting Live Real-Time Market Price Streamer (1000ms tick interval)...');

    this.timer = setInterval(() => {
      this.generateTicks();
    }, 1000);
  }

  private async generateTicks() {
    const redisClient = this.redis.getClient();

    for (const [symbol, ticker] of this.tickers.entries()) {
      const delta = (Math.random() - 0.49) * ticker.volatility;
      let newPrice = ticker.price + delta;

      newPrice = Math.round(newPrice / ticker.tickSize) * ticker.tickSize;
      newPrice = Number(newPrice.toFixed(2));

      ticker.price = newPrice;
      ticker.close = newPrice;
      if (newPrice > ticker.high) ticker.high = newPrice;
      if (newPrice < ticker.low) ticker.low = newPrice;
      ticker.volume += Math.floor(Math.random() * 25) + 1;

      const changeAmount = Number((newPrice - ticker.prevClose).toFixed(2));
      const changePercent = Number(((changeAmount / ticker.prevClose) * 100).toFixed(2));

      const tickPayload = {
        symbol,
        timeframe: '15m',
        price: newPrice,
        open: ticker.open,
        high: ticker.high,
        low: ticker.low,
        close: newPrice,
        volume: ticker.volume,
        changeAmount,
        changePercent,
        timestamp: new Date().toISOString(),
      };

      if (redisClient && redisClient.status === 'ready') {
        await redisClient.publish(WS_EVENTS.CANDLE_UPDATED, JSON.stringify(tickPayload));
      }
    }
  }

  getTicker(symbol: string) {
    return this.tickers.get(symbol.toUpperCase());
  }

  getAllTickers() {
    return Array.from(this.tickers.values());
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
