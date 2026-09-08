"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var TradingWebsocketGateway_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TradingWebsocketGateway = void 0;
const websockets_1 = require("@nestjs/websockets");
const common_1 = require("@nestjs/common");
const socket_io_1 = require("socket.io");
const redis_service_1 = require("../common/redis/redis.service");
const shared_1 = require("@quant/shared");
const ioredis_1 = __importDefault(require("ioredis"));
let TradingWebsocketGateway = TradingWebsocketGateway_1 = class TradingWebsocketGateway {
    redisService;
    server;
    logger = new common_1.Logger(TradingWebsocketGateway_1.name);
    subscriberClient;
    connectedClientsCount = 0;
    constructor(redisService) {
        this.redisService = redisService;
    }
    afterInit() {
        this.logger.log('Trading WebSocket Gateway initialized');
        // Create a dedicated Redis subscriber connection
        const host = process.env.REDIS_HOST || 'localhost';
        const port = Number(process.env.REDIS_PORT) || 6380;
        const password = process.env.REDIS_PASSWORD || undefined;
        this.subscriberClient = new ioredis_1.default({
            host,
            port,
            password,
            maxRetriesPerRequest: null,
        });
        this.subscriberClient.subscribe(shared_1.WS_EVENTS.CANDLE_UPDATED, shared_1.WS_EVENTS.SIGNAL_CREATED, shared_1.WS_EVENTS.SIGNAL_GENERATED, shared_1.WS_EVENTS.SIGNAL_UPDATED, shared_1.WS_EVENTS.ALERT_TRIGGERED, shared_1.WS_EVENTS.SCANNER_UPDATED, shared_1.WS_EVENTS.MARKET_REGIME_CHANGED, (err, count) => {
            if (err) {
                this.logger.error(`Redis subscribe error: ${err.message}`);
            }
            else {
                this.logger.log(`Subscribed to ${count} Redis PubSub channels`);
            }
        });
        this.subscriberClient.on('message', (channel, message) => {
            this.handleRedisMessage(channel, message);
        });
    }
    handleConnection(client) {
        this.connectedClientsCount++;
        this.logger.log(`Client connected: ${client.id}. Total connected: ${this.connectedClientsCount}`);
        client.emit('connected', {
            status: 'CONNECTED',
            timestamp: new Date().toISOString(),
            clientId: client.id,
        });
    }
    handleDisconnect(client) {
        this.connectedClientsCount = Math.max(0, this.connectedClientsCount - 1);
        this.logger.log(`Client disconnected: ${client.id}. Remaining: ${this.connectedClientsCount}`);
    }
    handleSubscribeInstrument(client, payload) {
        if (!payload?.symbol)
            return { success: false, error: 'Symbol is required' };
        const sym = payload.symbol.toUpperCase();
        const room = `instrument:${sym}`;
        client.join(room);
        this.logger.debug(`Client ${client.id} subscribed to ${room}`);
        return { success: true, room };
    }
    handleUnsubscribeInstrument(client, payload) {
        if (!payload?.symbol)
            return { success: false };
        const sym = payload.symbol.toUpperCase();
        const room = `instrument:${sym}`;
        client.leave(room);
        return { success: true, left: room };
    }
    handleSubscribeScanner(client) {
        client.join('scanner');
        return { success: true, room: 'scanner' };
    }
    handleSubscribeSignals(client) {
        client.join('signals');
        return { success: true, room: 'signals' };
    }
    handleSubscribeAlerts(client) {
        client.join('alerts');
        return { success: true, room: 'alerts' };
    }
    handleRedisMessage(channel, message) {
        try {
            const data = JSON.parse(message);
            switch (channel) {
                case shared_1.WS_EVENTS.CANDLE_UPDATED:
                    // Broadcast to symbol room and global candle room
                    if (data?.symbol) {
                        this.server.to(`instrument:${data.symbol}`).emit(shared_1.WS_EVENTS.CANDLE_UPDATED, data);
                    }
                    this.server.emit(shared_1.WS_EVENTS.CANDLE_UPDATED, data);
                    break;
                case shared_1.WS_EVENTS.SIGNAL_GENERATED:
                case shared_1.WS_EVENTS.SIGNAL_CREATED:
                    if (data?.symbol) {
                        this.server.to(`instrument:${data.symbol}`).emit(shared_1.WS_EVENTS.SIGNAL_GENERATED, data);
                    }
                    this.server.to('signals').emit(shared_1.WS_EVENTS.SIGNAL_GENERATED, data);
                    this.server.emit(shared_1.WS_EVENTS.SIGNAL_GENERATED, data);
                    break;
                case shared_1.WS_EVENTS.ALERT_TRIGGERED:
                    this.server.to('alerts').emit(shared_1.WS_EVENTS.ALERT_TRIGGERED, data);
                    this.server.emit(shared_1.WS_EVENTS.ALERT_TRIGGERED, data);
                    break;
                case shared_1.WS_EVENTS.SCANNER_UPDATED:
                    this.server.to('scanner').emit(shared_1.WS_EVENTS.SCANNER_UPDATED, data);
                    this.server.emit(shared_1.WS_EVENTS.SCANNER_UPDATED, data);
                    break;
                default:
                    this.server.emit(channel, data);
                    break;
            }
        }
        catch (e) {
            this.logger.error(`Error relaying Redis PubSub event on ${channel}: ${e.message}`);
        }
    }
    getConnectedClientsCount() {
        return this.connectedClientsCount;
    }
};
exports.TradingWebsocketGateway = TradingWebsocketGateway;
__decorate([
    (0, websockets_1.WebSocketServer)(),
    __metadata("design:type", socket_io_1.Server)
], TradingWebsocketGateway.prototype, "server", void 0);
__decorate([
    (0, websockets_1.SubscribeMessage)('subscribe:instrument'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [socket_io_1.Socket, Object]),
    __metadata("design:returntype", void 0)
], TradingWebsocketGateway.prototype, "handleSubscribeInstrument", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('unsubscribe:instrument'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [socket_io_1.Socket, Object]),
    __metadata("design:returntype", void 0)
], TradingWebsocketGateway.prototype, "handleUnsubscribeInstrument", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('subscribe:scanner'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], TradingWebsocketGateway.prototype, "handleSubscribeScanner", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('subscribe:signals'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], TradingWebsocketGateway.prototype, "handleSubscribeSignals", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('subscribe:alerts'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], TradingWebsocketGateway.prototype, "handleSubscribeAlerts", null);
exports.TradingWebsocketGateway = TradingWebsocketGateway = TradingWebsocketGateway_1 = __decorate([
    (0, websockets_1.WebSocketGateway)({
        cors: {
            origin: '*',
        },
    }),
    __metadata("design:paramtypes", [redis_service_1.RedisService])
], TradingWebsocketGateway);
//# sourceMappingURL=websocket.gateway.js.map