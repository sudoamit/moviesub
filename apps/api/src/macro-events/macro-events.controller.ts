import { Controller, Get } from '@nestjs/common';
import { MacroEventsService } from './macro-events.service';

@Controller('api/macro-events')
export class MacroEventsController {
  constructor(private readonly macroEventsService: MacroEventsService) {}

  @Get('calendar')
  async getCalendar() {
    return this.macroEventsService.getCalendar();
  }

  @Get('vix-regime')
  async getVIXRegime() {
    return this.macroEventsService.getVIXRegime();
  }
}
