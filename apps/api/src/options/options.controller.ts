import { Controller, Get, Query } from '@nestjs/common';
import { OptionsService } from './options.service';

@Controller('api/options')
export class OptionsController {
  constructor(private readonly optionsService: OptionsService) {}

  @Get('chain')
  async getOptionChain(
    @Query('symbol') symbol?: string,
    @Query('expiryDate') expiryDate?: string,
    @Query('spotPrice') spotPrice?: string,
  ) {
    return this.optionsService.getOptionChain(
      symbol || 'NIFTY',
      expiryDate,
      spotPrice ? parseFloat(spotPrice) : undefined,
    );
  }

  @Get('smart-strike')
  async getSmartStrike(
    @Query('symbol') symbol?: string,
    @Query('direction') direction?: 'BULLISH' | 'BEARISH',
    @Query('spotTarget') spotTarget?: string,
    @Query('spotStopLoss') spotStopLoss?: string,
    @Query('expiryDate') expiryDate?: string,
    @Query('spotPrice') spotPrice?: string,
    @Query('strike') strike?: string,
  ) {
    return this.optionsService.getSmartStrikeRecommendation(
      symbol || 'NIFTY',
      direction || 'BULLISH',
      spotTarget ? parseFloat(spotTarget) : undefined,
      spotStopLoss ? parseFloat(spotStopLoss) : undefined,
      expiryDate,
      spotPrice ? parseFloat(spotPrice) : undefined,
      strike ? parseFloat(strike) : undefined,
    );
  }
}
