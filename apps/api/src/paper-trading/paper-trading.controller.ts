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

  @Post('positions/:id/close')
  async closePositionById(
    @Param('id') id: string,
    @Body() body?: { reason?: string },
  ) {
    return this.paperTradingService.closePosition(id, body?.reason);
  }

  @Get('active-positions')
  async getActivePositions(@Query('accountId') accountId?: string) {
    return this.paperTradingService.getActivePositions(accountId);
  }

  @Post('clear-trades')
  async clearAllCompletedTrades(@Body() body?: { accountId?: string }) {
    return this.paperTradingService.clearAllCompletedTrades(body?.accountId);
  }

  @Post('reset')
  async resetPortfolio(@Body() body: { initialCapital?: number }) {
    return this.paperTradingService.resetPortfolio(body?.initialCapital);
  }
}
