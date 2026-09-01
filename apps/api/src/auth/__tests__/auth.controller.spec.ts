import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { SubscriptionTier } from '@quant/shared';

describe('AuthController', () => {
  let controller: AuthController;
  let service: any;

  const mockUserResponse = {
    user: {
      id: 'usr-1',
      email: 'trader@quant.io',
      name: 'Trader Pro',
      role: 'USER',
      tier: 'PRO',
    },
    accessToken: 'mock-jwt-token-xyz',
  };

  beforeEach(async () => {
    service = {
      register: jest.fn().mockResolvedValue(mockUserResponse),
      login: jest.fn().mockResolvedValue(mockUserResponse),
      getProfile: jest.fn().mockResolvedValue(mockUserResponse.user),
      upgradeTier: jest.fn().mockResolvedValue({ success: true, tier: 'ADVANCED' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: service }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should register a new user', async () => {
    const res = await controller.register({
      email: 'trader@quant.io',
      password: 'password123',
      name: 'Trader Pro',
    });
    expect(res.accessToken).toBe('mock-jwt-token-xyz');
    expect(res.user.tier).toBe('PRO');
  });

  it('should login an existing user', async () => {
    const res = await controller.login({
      email: 'trader@quant.io',
      password: 'password123',
    });
    expect(res.accessToken).toBe('mock-jwt-token-xyz');
  });

  it('should get profile for authenticated user', async () => {
    const res = await controller.getProfile({ user: { id: 'usr-1' } });
    expect(res.id).toBe('usr-1');
  });

  it('should upgrade tier', async () => {
    const res = await controller.upgradeTier(
      { user: { id: 'usr-1' } },
      { tier: SubscriptionTier.ADVANCED },
    );
    expect(res.success).toBe(true);
    expect(res.tier).toBe('ADVANCED');
  });
});
