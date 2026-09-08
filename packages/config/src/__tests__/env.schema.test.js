"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const env_schema_1 = require("../env.schema");
describe('EnvSchema', () => {
    it('should validate default environment values when provided minimum required fields', () => {
        const mockEnv = {
            DATABASE_URL: 'postgresql://postgres:postgrespassword@localhost:5433/trading_platform',
            REDIS_URL: 'redis://localhost:6380',
        };
        const config = (0, env_schema_1.validateEnv)(mockEnv);
        expect(config.DATABASE_URL).toBe('postgresql://postgres:postgrespassword@localhost:5433/trading_platform');
        expect(config.REDIS_HOST).toBe('localhost');
        expect(config.REDIS_PORT).toBe(6380);
        expect(config.PORT).toBe(3001);
        expect(config.NODE_ENV).toBe('development');
    });
    it('should override default values when environment variables are supplied', () => {
        const mockEnv = {
            NODE_ENV: 'production',
            PORT: '8080',
            DATABASE_URL: 'postgresql://user:pass@prod-db:5432/trading',
            REDIS_HOST: 'redis-prod',
            REDIS_PORT: '6379',
        };
        const config = (0, env_schema_1.validateEnv)(mockEnv);
        expect(config.NODE_ENV).toBe('production');
        expect(config.PORT).toBe(8080);
        expect(config.REDIS_HOST).toBe('redis-prod');
        expect(config.REDIS_PORT).toBe(6379);
    });
});
//# sourceMappingURL=env.schema.test.js.map