import {
  Controller,
  Get,
  Param,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { RealMarketStreamerService } from './real-market-streamer.service';
import { MarketDataUnavailableError } from '@quant/shared';

@Controller('api/market-data')
export class MarketDataController {
  constructor(private readonly realMarketStreamer: RealMarketStreamerService) {}

  @Get('snapshot/:symbol')
  getSnapshot(@Param('symbol') symbol: string) {
    try {
      return this.realMarketStreamer.getAuthoritativeSnapshot(symbol);
    } catch (err: any) {
      if (err instanceof MarketDataUnavailableError) {
        throw new HttpException(
          {
            statusCode: HttpStatus.SERVICE_UNAVAILABLE,
            message: err.message,
            symbol: err.symbol,
            error: 'MarketDataUnavailable',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw err;
    }
  }

  @Get('snapshot')
  getDefaultSnapshot() {
    return this.getSnapshot('BTCUSDT_SPOT');
  }

  @Get('btc-spot-snapshot')
  getBtcSpotSnapshot() {
    return this.getSnapshot('BTCUSDT_SPOT');
  }
}
