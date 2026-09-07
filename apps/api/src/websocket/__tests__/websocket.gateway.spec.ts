import { Test, TestingModule } from '@nestjs/testing';
import { TradingWebsocketGateway } from '../websocket.gateway';
import { RedisService } from '../../common/redis/redis.service';

describe('TradingWebsocketGateway', () => {
  let gateway: TradingWebsocketGateway;
  let mockRedis: any;

  beforeEach(async () => {
    mockRedis = {
      getClient: jest.fn().mockReturnValue({
        status: 'ready',
        publish: jest.fn(),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [TradingWebsocketGateway, { provide: RedisService, useValue: mockRedis }],
    }).compile();

    gateway = module.get<TradingWebsocketGateway>(TradingWebsocketGateway);
  });

  it('should handle instrument subscription', () => {
    const mockSocket = {
      id: 'sock-1',
      join: jest.fn(),
      leave: jest.fn(),
      emit: jest.fn(),
    } as any;

    const res = gateway.handleSubscribeInstrument(mockSocket, { symbol: 'NIFTY' });
    expect(res.success).toBe(true);
    expect(res.room).toBe('instrument:NIFTY');
    expect(mockSocket.join).toHaveBeenCalledWith('instrument:NIFTY');
  });

  it('should handle scanner subscription', () => {
    const mockSocket = {
      id: 'sock-1',
      join: jest.fn(),
    } as any;

    const res = gateway.handleSubscribeScanner(mockSocket);
    expect(res.success).toBe(true);
    expect(res.room).toBe('scanner');
    expect(mockSocket.join).toHaveBeenCalledWith('scanner');
  });
});
