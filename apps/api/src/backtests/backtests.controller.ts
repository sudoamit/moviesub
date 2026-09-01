import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { BacktestsService } from './backtests.service';
import { RunBacktestDto } from './dto/run-backtest.dto';

@Controller('api/backtests')
export class BacktestsController {
  constructor(private readonly backtestsService: BacktestsService) {}

  @Post('run')
  async runBacktest(@Body() body: RunBacktestDto) {
    return this.backtestsService.runBacktest(body);
  }

  @Get()
  async listBacktests() {
    return this.backtestsService.listBacktests();
  }

  @Get(':id')
  async getBacktestById(@Param('id') id: string) {
    return this.backtestsService.getBacktestById(id);
  }
}
