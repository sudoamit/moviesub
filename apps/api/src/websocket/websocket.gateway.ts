import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { RedisService } from '../common/redis/redis.service';
import { WS_EVENTS } from '@quant/shared';
import Redis from 'ioredis';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class TradingWebsocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(TradingWebsocketGateway.name);
  private subscriberClient!: Redis;
  private connectedClientsCount = 0;

  constructor(private readonly redisService: RedisService) {}

  afterInit() {
    this.logger.log('Trading WebSocket Gateway initialized');

    // Create a dedicated Redis subscriber connection
    const host = process.env.REDIS_HOST || 'localhost';
    const port = Number(process.env.REDIS_PORT) || 6380;
    const password = process.env.REDIS_PASSWORD || undefined;

    this.subscriberClient = new Redis({
      host,
      port,
      password,
      maxRetriesPerRequest: null,
    });

    this.subscriberClient.subscribe(
      WS_EVENTS.CANDLE_UPDATED,
      WS_EVENTS.SIGNAL_CREATED,
      WS_EVENTS.SIGNAL_GENERATED,
      WS_EVENTS.SIGNAL_UPDATED,
      WS_EVENTS.ALERT_TRIGGERED,
      WS_EVENTS.SCANNER_UPDATED,
      WS_EVENTS.MARKET_REGIME_CHANGED,
      (err, count) => {
        if (err) {
          this.logger.error(`Redis subscribe error: ${err.message}`);
        } else {
          this.logger.log(`Subscribed to ${count} Redis PubSub channels`);
        }
      },
    );

    this.subscriberClient.on('message', (channel, message) => {
      this.handleRedisMessage(channel, message);
    });
  }

  handleConnection(client: Socket) {
    this.connectedClientsCount++;
    this.logger.log(
      `Client connected: ${client.id}. Total connected: ${this.connectedClientsCount}`,
    );
    client.emit('connected', {
      status: 'CONNECTED',
      timestamp: new Date().toISOString(),
      clientId: client.id,
    });
  }

  handleDisconnect(client: Socket) {
    this.connectedClientsCount = Math.max(0, this.connectedClientsCount - 1);
    this.logger.log(`Client disconnected: ${client.id}. Remaining: ${this.connectedClientsCount}`);
  }

  @SubscribeMessage('subscribe:instrument')
  handleSubscribeInstrument(client: Socket, payload: { symbol: string; timeframe?: string }) {
    if (!payload?.symbol) return { success: false, error: 'Symbol is required' };
    const sym = payload.symbol.toUpperCase();
    const room = `instrument:${sym}`;
    client.join(room);
    this.logger.debug(`Client ${client.id} subscribed to ${room}`);
    return { success: true, room };
  }

  @SubscribeMessage('unsubscribe:instrument')
  handleUnsubscribeInstrument(client: Socket, payload: { symbol: string }) {
    if (!payload?.symbol) return { success: false };
    const sym = payload.symbol.toUpperCase();
    const room = `instrument:${sym}`;
    client.leave(room);
    return { success: true, left: room };
  }

  @SubscribeMessage('subscribe:scanner')
  handleSubscribeScanner(client: Socket) {
    client.join('scanner');
    return { success: true, room: 'scanner' };
  }

  @SubscribeMessage('subscribe:signals')
  handleSubscribeSignals(client: Socket) {
    client.join('signals');
    return { success: true, room: 'signals' };
  }

  @SubscribeMessage('subscribe:alerts')
  handleSubscribeAlerts(client: Socket) {
    client.join('alerts');
    return { success: true, room: 'alerts' };
  }

  private handleRedisMessage(channel: string, message: string) {
    try {
      const data = JSON.parse(message);

      switch (channel) {
        case WS_EVENTS.CANDLE_UPDATED:
          // Broadcast to symbol room and global candle room
          if (data?.symbol) {
            this.server.to(`instrument:${data.symbol}`).emit(WS_EVENTS.CANDLE_UPDATED, data);
          }
          this.server.emit(WS_EVENTS.CANDLE_UPDATED, data);
          break;

        case WS_EVENTS.SIGNAL_GENERATED:
        case WS_EVENTS.SIGNAL_CREATED:
          if (data?.symbol) {
            this.server.to(`instrument:${data.symbol}`).emit(WS_EVENTS.SIGNAL_GENERATED, data);
          }
          this.server.to('signals').emit(WS_EVENTS.SIGNAL_GENERATED, data);
          this.server.emit(WS_EVENTS.SIGNAL_GENERATED, data);
          break;

        case WS_EVENTS.ALERT_TRIGGERED:
          this.server.to('alerts').emit(WS_EVENTS.ALERT_TRIGGERED, data);
          this.server.emit(WS_EVENTS.ALERT_TRIGGERED, data);
          break;

        case WS_EVENTS.SCANNER_UPDATED:
          this.server.to('scanner').emit(WS_EVENTS.SCANNER_UPDATED, data);
          this.server.emit(WS_EVENTS.SCANNER_UPDATED, data);
          break;

        default:
          this.server.emit(channel, data);
          break;
      }
    } catch (e) {
      this.logger.error(`Error relaying Redis PubSub event on ${channel}: ${(e as Error).message}`);
    }
  }

  getConnectedClientsCount(): number {
    return this.connectedClientsCount;
  }
}
