import { Controller, Get, Post, Query } from '@nestjs/common';
import { ScannerService } from './scanner.service';
import { Timeframe } from '@quant/shared';

@Controller('api/scanner')
export class ScannerController {
  constructor(private readonly scannerService: ScannerService) {}

  @Post('scan')
  async triggerScan(
    @Query('timeframe') timeframe: Timeframe = Timeframe.M15,
    @Query('strategy') strategy: 'SMC' | 'SAIYAN_OCC' | 'HYBRID' = 'SMC',
  ) {
    return this.scannerService.triggerScan(timeframe, strategy);
  }

  @Get('status')
  async getStatus() {
    return this.scannerService.getScannerStatus();
  }
}
