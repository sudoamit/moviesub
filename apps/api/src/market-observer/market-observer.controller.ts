import { Controller, Get, Post } from '@nestjs/common';
import { MarketObserverService } from './market-observer.service';

@Controller('api/observer')
export class MarketObserverController {
  constructor(private readonly observer: MarketObserverService) {}

  /** Latest option-chain / volatility snapshots, recent scored news and collection counts. */
  @Get('status')
  async status() {
    return this.observer.status();
  }

  /** Which observed inputs have predicted price moves (COLLECTING / NO_RELATIONSHIP / LEARNED). */
  @Get('insights')
  async insights() {
    return this.observer.insights();
  }

  /** Runs every collector once now (normally on timers). */
  @Post('run')
  async run() {
    return this.observer.runAll();
  }
}
