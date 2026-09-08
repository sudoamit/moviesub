"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnvSchema = void 0;
exports.validateEnv = validateEnv;
const zod_1 = require("zod");
exports.EnvSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'test', 'production']).default('development'),
    PORT: zod_1.z.coerce.number().default(3001),
    WEB_PORT: zod_1.z.coerce.number().default(3000),
    DATABASE_URL: zod_1.z.string().url().or(zod_1.z.string().min(1)),
    REDIS_HOST: zod_1.z.string().default('localhost'),
    REDIS_PORT: zod_1.z.coerce.number().default(6380),
    REDIS_PASSWORD: zod_1.z.string().optional().default(''),
    REDIS_URL: zod_1.z.string().default('redis://localhost:6380'),
    JWT_SECRET: zod_1.z.string().default('super_secret_jwt_key_quant_trading_dev_2026'),
    JWT_EXPIRES_IN: zod_1.z.string().default('7d'),
    JWT_REFRESH_SECRET: zod_1.z.string().default('super_secret_refresh_key_quant_trading_dev_2026'),
    JWT_REFRESH_EXPIRES_IN: zod_1.z.string().default('30d'),
    CORS_ORIGIN: zod_1.z.string().default('http://localhost:3000'),
    LOG_LEVEL: zod_1.z.enum(['error', 'warn', 'info', 'debug', 'verbose']).default('info'),
    ENABLE_QUANT_FEATURES: zod_1.z.preprocess((val) => val === 'true' || val === true || val === undefined, zod_1.z.boolean().default(true)),
    ENABLE_REGIME_MODEL: zod_1.z.preprocess((val) => val === 'true' || val === true || val === undefined, zod_1.z.boolean().default(true)),
    ENABLE_VOLATILITY_FORECAST: zod_1.z.preprocess((val) => val === 'true' || val === true || val === undefined, zod_1.z.boolean().default(true)),
    ENABLE_LLM_CONTEXT: zod_1.z.preprocess((val) => val === 'true' || val === true, zod_1.z.boolean().default(false)),
    ENABLE_ALTERNATIVE_DATA: zod_1.z.preprocess((val) => val === 'true' || val === true || val === undefined, zod_1.z.boolean().default(true)),
    ENABLE_LEARNING_ENGINE: zod_1.z.preprocess((val) => val === 'true' || val === true, zod_1.z.boolean().default(false)),
    ENABLE_PATTERN_DISCOVERY: zod_1.z.preprocess((val) => val === 'true' || val === true, zod_1.z.boolean().default(false)),
    ENABLE_CANDIDATE_GENERATION: zod_1.z.preprocess((val) => val === 'true' || val === true, zod_1.z.boolean().default(false)),
    ENABLE_SHADOW_TRADING: zod_1.z.preprocess((val) => val === 'true' || val === true, zod_1.z.boolean().default(false)),
    ENABLE_AUTO_PROMOTION: zod_1.z.preprocess((val) => val === 'true' || val === true, zod_1.z.boolean().default(false)),
    ENABLE_LLM_LEARNING: zod_1.z.preprocess((val) => val === 'true' || val === true, zod_1.z.boolean().default(false)),
    ENABLE_REGIME_LEARNING: zod_1.z.preprocess((val) => val === 'true' || val === true, zod_1.z.boolean().default(false)),
    ENABLE_VOLATILITY_LEARNING: zod_1.z.preprocess((val) => val === 'true' || val === true, zod_1.z.boolean().default(false)),
});
function validateEnv(config = process.env) {
    const result = exports.EnvSchema.safeParse(config);
    if (!result.success) {
        throw new Error(`Environment validation failed: ${JSON.stringify(result.error.format())}`);
    }
    return result.data;
}
//# sourceMappingURL=env.schema.js.map