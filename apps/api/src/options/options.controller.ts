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
    @Query('currentSpotPrice') currentSpotPrice?: string,
    @Query('underlyingTriggerPrice') underlyingTriggerPrice?: string,
    @Query('strike') strike?: string,
    @Query('triggerMode') triggerMode?: 'OPTION_PREMIUM' | 'UNDERLYING_SPOT',
  ) {
    return this.optionsService.getSmartStrikeRecommendation({
      symbol: symbol || 'NIFTY',
      direction: direction || 'BULLISH',
      spotTarget: spotTarget ? parseFloat(spotTarget) : undefined,
      spotStopLoss: spotStopLoss ? parseFloat(spotStopLoss) : undefined,
      targetExpiryDate: expiryDate,
      currentSpotPrice: currentSpotPrice ? parseFloat(currentSpotPrice) : (spotPrice ? parseFloat(spotPrice) : undefined),
      underlyingTriggerPrice: underlyingTriggerPrice ? parseFloat(underlyingTriggerPrice) : undefined,
      strikeOverride: strike ? parseFloat(strike) : undefined,
      triggerMode,
    });
  }
}
