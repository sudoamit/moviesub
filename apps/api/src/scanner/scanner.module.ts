import { Module } from '@nestjs/common';
import { ScannerController } from './scanner.controller';
import { ScannerService } from './scanner.service';
import { SignalsModule } from '../signals/signals.module';
import { AlgoBotsModule } from '../algo-bots/algo-bots.module';

@Module({
  imports: [SignalsModule, AlgoBotsModule],
  controllers: [ScannerController],
  providers: [ScannerService],
  exports: [ScannerService],
})
export class ScannerModule {}
