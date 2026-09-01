import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { PaperTradingService, IPaperOrderRequest } from './paper-trading.service';

@Controller('api/paper-trading')
export class PaperTradingController {
  constructor(private readonly paperTradingService: PaperTradingService) {}

  @Get('portfolio')
  async getPortfolio() {
    return this.paperTradingService.getPortfolio();
  }

  @Post('order')
  async placeOrder(@Body() orderDto: IPaperOrderRequest) {
    return this.paperTradingService.placeOrder(orderDto);
  }

  @Post('close-position')
  async closePosition(@Body() body: { positionId: string; reason?: string }) {
    return this.paperTradingService.closePosition(body.positionId, body.reason);
  }

  @Post('reset')
  async resetPortfolio(@Body() body: { initialCapital?: number }) {
    return this.paperTradingService.resetPortfolio(body?.initialCapital);
  }
}
