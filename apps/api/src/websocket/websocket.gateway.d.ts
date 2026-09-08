import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RedisService } from '../common/redis/redis.service';
export declare class TradingWebsocketGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
    private readonly redisService;
    server: Server;
    private readonly logger;
    private subscriberClient;
    private connectedClientsCount;
    constructor(redisService: RedisService);
    afterInit(): void;
    handleConnection(client: Socket): void;
    handleDisconnect(client: Socket): void;
    handleSubscribeInstrument(client: Socket, payload: {
        symbol: string;
        timeframe?: string;
    }): {
        success: boolean;
        error: string;
        room?: undefined;
    } | {
        success: boolean;
        room: string;
        error?: undefined;
    };
    handleUnsubscribeInstrument(client: Socket, payload: {
        symbol: string;
    }): {
        success: boolean;
        left?: undefined;
    } | {
        success: boolean;
        left: string;
    };
    handleSubscribeScanner(client: Socket): {
        success: boolean;
        room: string;
    };
    handleSubscribeSignals(client: Socket): {
        success: boolean;
        room: string;
    };
    handleSubscribeAlerts(client: Socket): {
        success: boolean;
        room: string;
    };
    private handleRedisMessage;
    getConnectedClientsCount(): number;
}
