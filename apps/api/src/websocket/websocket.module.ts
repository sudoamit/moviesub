import { Module } from '@nestjs/common';
import { TradingWebsocketGateway } from './websocket.gateway';
import { RedisModule } from '../common/redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [TradingWebsocketGateway],
  exports: [TradingWebsocketGateway],
})
export class WebsocketModule {}
