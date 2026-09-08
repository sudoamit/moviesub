"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const websocket_gateway_1 = require("../websocket.gateway");
const redis_service_1 = require("../../common/redis/redis.service");
describe('TradingWebsocketGateway', () => {
    let gateway;
    let mockRedis;
    beforeEach(async () => {
        mockRedis = {
            getClient: jest.fn().mockReturnValue({
                status: 'ready',
                publish: jest.fn(),
            }),
        };
        const module = await testing_1.Test.createTestingModule({
            providers: [websocket_gateway_1.TradingWebsocketGateway, { provide: redis_service_1.RedisService, useValue: mockRedis }],
        }).compile();
        gateway = module.get(websocket_gateway_1.TradingWebsocketGateway);
    });
    it('should handle instrument subscription', () => {
        const mockSocket = {
            id: 'sock-1',
            join: jest.fn(),
            leave: jest.fn(),
            emit: jest.fn(),
        };
        const res = gateway.handleSubscribeInstrument(mockSocket, { symbol: 'NIFTY' });
        expect(res.success).toBe(true);
        expect(res.room).toBe('instrument:NIFTY');
        expect(mockSocket.join).toHaveBeenCalledWith('instrument:NIFTY');
    });
    it('should handle scanner subscription', () => {
        const mockSocket = {
            id: 'sock-1',
            join: jest.fn(),
        };
        const res = gateway.handleSubscribeScanner(mockSocket);
        expect(res.success).toBe(true);
        expect(res.room).toBe('scanner');
        expect(mockSocket.join).toHaveBeenCalledWith('scanner');
    });
});
//# sourceMappingURL=websocket.gateway.spec.js.map