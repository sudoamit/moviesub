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
  async placeOrder(@Body() orderDto: IPaperOrderRequest) {
    return this.paperTradingService.placeOrder(orderDto);
  }

  @Post('close-position')
  async closePosition(
    @Body()
    body: {
      positionId: string;
      reason?: string;
      exitPrice?: number;
      exitPriceOverride?: number;
      allowPriceOverride?: boolean;
      partialRatio?: number;
    },
  ) {
    if (body.partialRatio && body.partialRatio < 1.0 && this.paperPositionMonitorService) {
      const pos = await this.paperTradingService.getPositionById(body.positionId);
      if (pos && pos.status !== 'CLOSED' && pos.status !== 'CLOSING') {
        const exitP = body.exitPriceOverride ?? body.exitPrice ?? Number(pos.currentPrice ?? pos.entryPrice);
        const stage = pos.status === 'PARTIALLY_CLOSED' ? 'TP2' : 'TP1';
        const res = await this.paperPositionMonitorService.executePartialScaleOut(
          pos,
          stage,
          exitP,
          exitP,
          new Date(),
          body.partialRatio,
        );
        if (res) return res;
      }
    }

    return this.paperTradingService.closePosition(body.positionId, body.reason, {
      exitPriceOverride: body.exitPriceOverride ?? body.exitPrice,
      allowPriceOverride: body.allowPriceOverride ?? true,
    });
  }

  @Post('positions/:id/close')
  async closePositionById(
    @Param('id') id: string,
    @Body()
    body?: {
      reason?: string;
      exitPrice?: number;
      exitPriceOverride?: number;
      allowPriceOverride?: boolean;
      partialRatio?: number;
    },
  ) {
    if (body?.partialRatio && body.partialRatio < 1.0 && this.paperPositionMonitorService) {
      const pos = await this.paperTradingService.getPositionById(id);
      if (pos && pos.status !== 'CLOSED' && pos.status !== 'CLOSING') {
        const exitP = body.exitPriceOverride ?? body.exitPrice ?? Number(pos.currentPrice ?? pos.entryPrice);
        const stage = pos.status === 'PARTIALLY_CLOSED' ? 'TP2' : 'TP1';
        const res = await this.paperPositionMonitorService.executePartialScaleOut(
          pos,
          stage,
          exitP,
          exitP,
          new Date(),
          body.partialRatio,
        );
        if (res) return res;
      }
    }

    return this.paperTradingService.closePosition(id, body?.reason, {
      exitPriceOverride: body?.exitPriceOverride ?? body?.exitPrice,
      allowPriceOverride: body?.allowPriceOverride ?? true,
    });
  }

  @Post('positions/:id/scale-out')
  async scaleOutPositionById(
    @Param('id') id: string,
    @Body()
    body?: {
      ratio?: number;
      exitPrice?: number;
      reason?: string;
    },
  ) {
    if (!this.paperPositionMonitorService) {
      throw new BadRequestException('Position monitor service unavailable for scale-out');
    }
    const pos = await this.paperTradingService.getPositionById(id);
    if (!pos || pos.status === 'CLOSED' || pos.status === 'CLOSING') {
      throw new NotFoundException(`Active position '${id}' not found`);
    }
    const ratio = body?.ratio ?? 0.5;
    const exitP = body?.exitPrice ?? Number(pos.currentPrice ?? pos.entryPrice);
    const stage = pos.status === 'PARTIALLY_CLOSED' ? 'TP2' : 'TP1';
    const res = await this.paperPositionMonitorService.executePartialScaleOut(
      pos,
      stage,
      exitP,
      exitP,
      new Date(),
      ratio,
    );
    return res || { success: true, message: 'Scale-out already executed or position closed' };
  }

  @Post('scale-out')
  async scaleOutPosition(
    @Body()
    body: {
      positionId: string;
      ratio?: number;
      exitPrice?: number;
      reason?: string;
    },
  ) {
    return this.scaleOutPositionById(body.positionId, body);
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
