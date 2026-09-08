"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const auth_controller_1 = require("../auth.controller");
const auth_service_1 = require("../auth.service");
const shared_1 = require("@quant/shared");
describe('AuthController', () => {
    let controller;
    let service;
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
        const module = await testing_1.Test.createTestingModule({
            controllers: [auth_controller_1.AuthController],
            providers: [{ provide: auth_service_1.AuthService, useValue: service }],
        }).compile();
        controller = module.get(auth_controller_1.AuthController);
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
        const res = await controller.upgradeTier({ user: { id: 'usr-1' } }, { tier: shared_1.SubscriptionTier.ADVANCED });
        expect(res.success).toBe(true);
        expect(res.tier).toBe('ADVANCED');
    });
});
//# sourceMappingURL=auth.controller.spec.js.map