import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Optional,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PaperTradingService, IPaperOrderRequest } from './paper-trading.service';
import { PaperPositionMonitorService } from './paper-position-monitor.service';
import {
  ClosePositionByBodyDto,
  ClosePositionDto,
  PlaceOrderDto,
  ScaleOutByBodyDto,
  ScaleOutDto,
} from './dto/paper-trading.dto';

@Controller('api/paper-trading')
export class PaperTradingController {
  constructor(
    private readonly paperTradingService: PaperTradingService,
    @Optional() private readonly paperPositionMonitorService?: PaperPositionMonitorService,
  ) {}

  @Get('portfolio')
  async getPortfolio() {
    return this.paperTradingService.getPortfolio();
  }

  @Post('order')
  async placeOrder(@Body() orderDto: PlaceOrderDto) {
    // Only whitelisted, non-authoritative fields reach the execution boundary (see PlaceOrderDto).
    return this.paperTradingService.placeOrder(orderDto as IPaperOrderRequest);
  }

  /**
   * Manual close. The exit is always priced by the server from the validated live quote;
   * client-supplied exit prices are not accepted.
   */
  @Post('close-position')
  async closePosition(@Body() body: ClosePositionByBodyDto) {
    return this.closeOrScaleOut(body.positionId, body.reason, body.partialRatio);
  }

  @Post('positions/:id/close')
  async closePositionById(@Param('id') id: string, @Body() body?: ClosePositionDto) {
    return this.closeOrScaleOut(id, body?.reason, body?.partialRatio);
  }

  @Post('positions/:id/scale-out')
  async scaleOutPositionById(@Param('id') id: string, @Body() body?: ScaleOutDto) {
    const res = await this.scaleOutAtLiveQuote(id, body?.ratio ?? 0.5);
    return res || { success: true, message: 'Scale-out already executed or position closed' };
  }

  @Post('scale-out')
  async scaleOutPosition(@Body() body: ScaleOutByBodyDto) {
    return this.scaleOutPositionById(body.positionId, body);
  }

  private async closeOrScaleOut(positionId: string, reason?: string, partialRatio?: number) {
    if (partialRatio && partialRatio < 1.0) {
      const res = await this.scaleOutAtLiveQuote(positionId, partialRatio);
      if (res) return res;
    }
    return this.paperTradingService.closePosition(positionId, reason);
  }

  /**
   * Partial exit priced from the validated live quote for the exact executed instrument.
   * Fails closed when no fresh quote exists (never falls back to a stale DB price or a client price).
   */
  private async scaleOutAtLiveQuote(positionId: string, ratio: number) {
    if (!this.paperPositionMonitorService) {
      throw new BadRequestException('Position monitor service unavailable for scale-out');
    }
    const pos = await this.paperTradingService.getPositionById(positionId);
    if (!pos || pos.status === 'CLOSED' || pos.status === 'CLOSING') {
      throw new NotFoundException(`Active position '${positionId}' not found`);
    }
    let quote: { price: number; timestamp: Date };
    try {
      quote = await this.paperTradingService.resolveLivePositionQuote(pos);
    } catch (err: any) {
      throw new BadRequestException(
        `Cannot scale out '${positionId}': real-time market data unavailable (${err.message}).`,
      );
    }
    const stage = pos.status === 'PARTIALLY_CLOSED' ? 'TP2' : 'TP1';
    try {
      return await this.paperPositionMonitorService.executePartialScaleOut(
        pos,
        stage,
        quote.price,
        quote.price,
        quote.timestamp,
        ratio,
      );
    } catch (err: any) {
      if (String(err?.message).startsWith('PARTIAL_BELOW_ONE_LOT')) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  @Get('active-positions')
  async getActivePositions(@Query('accountId') accountId?: string) {
    return this.paperTradingService.getActivePositions(accountId);
  }

  @Get('completed-trades')
  async getCompletedTrades(
    @Query('accountId') accountId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.paperTradingService.getCompletedTrades(
      accountId,
      limit ? parseInt(limit, 10) : 200,
    );
  }

  @Delete('clear-trades')
  async deleteCompletedTrades(@Query('accountId') accountId?: string) {
    return this.paperTradingService.clearAllCompletedTrades(accountId);
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
