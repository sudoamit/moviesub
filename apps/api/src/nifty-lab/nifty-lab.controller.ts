import { Controller, Get, Post } from '@nestjs/common';
import { NiftyLabService } from './nifty-lab.service';

@Controller('api/nifty-lab')
export class NiftyLabController {
  constructor(private readonly lab: NiftyLabService) {}

  /** Watch strategies with live results, the learned option model and condition insights. */
  @Get()
  async summary() {
    return this.lab.summary();
  }

  /** Runs one live evaluation now (normally every minute during NSE hours). */
  @Post('tick')
  async tick() {
    await this.lab.tick();
    return this.lab.summary();
  }

  /** Re-runs the NIFTY study now (normally weekly) and registers new watch candidates. */
  @Post('study')
  async study() {
    return this.lab.runStudy();
  }
}
