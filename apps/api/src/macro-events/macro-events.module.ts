import { Module } from '@nestjs/common';
import { MacroEventsService } from './macro-events.service';
import { MacroEventsController } from './macro-events.controller';

@Module({
  controllers: [MacroEventsController],
  providers: [MacroEventsService],
  exports: [MacroEventsService],
})
export class MacroEventsModule {}
