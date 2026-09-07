import { z } from 'zod';

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  WEB_PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url().or(z.string().min(1)),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6380),
  REDIS_PASSWORD: z.string().optional().default(''),
  REDIS_URL: z.string().default('redis://localhost:6380'),
  JWT_SECRET: z.string().default('super_secret_jwt_key_quant_trading_dev_2026'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  JWT_REFRESH_SECRET: z.string().default('super_secret_refresh_key_quant_trading_dev_2026'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'verbose']).default('info'),
  ENABLE_QUANT_FEATURES: z.preprocess(
    (val) => val === 'true' || val === true || val === undefined,
    z.boolean().default(true),
  ),
  ENABLE_REGIME_MODEL: z.preprocess(
    (val) => val === 'true' || val === true || val === undefined,
    z.boolean().default(true),
  ),
  ENABLE_VOLATILITY_FORECAST: z.preprocess(
    (val) => val === 'true' || val === true || val === undefined,
    z.boolean().default(true),
  ),
  ENABLE_LLM_CONTEXT: z.preprocess(
    (val) => val === 'true' || val === true,
    z.boolean().default(false),
  ),
  ENABLE_ALTERNATIVE_DATA: z.preprocess(
    (val) => val === 'true' || val === true || val === undefined,
    z.boolean().default(true),
  ),
  ENABLE_LEARNING_ENGINE: z.preprocess(
    (val) => val === 'true' || val === true,
    z.boolean().default(false),
  ),
  ENABLE_PATTERN_DISCOVERY: z.preprocess(
    (val) => val === 'true' || val === true,
    z.boolean().default(false),
  ),
  ENABLE_CANDIDATE_GENERATION: z.preprocess(
    (val) => val === 'true' || val === true,
    z.boolean().default(false),
  ),
  ENABLE_SHADOW_TRADING: z.preprocess(
    (val) => val === 'true' || val === true,
    z.boolean().default(false),
  ),
  ENABLE_AUTO_PROMOTION: z.preprocess(
    (val) => val === 'true' || val === true,
    z.boolean().default(false),
  ),
  ENABLE_LLM_LEARNING: z.preprocess(
    (val) => val === 'true' || val === true,
    z.boolean().default(false),
  ),
  ENABLE_REGIME_LEARNING: z.preprocess(
    (val) => val === 'true' || val === true,
    z.boolean().default(false),
  ),
  ENABLE_VOLATILITY_LEARNING: z.preprocess(
    (val) => val === 'true' || val === true,
    z.boolean().default(false),
  ),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

export function validateEnv(config: Record<string, unknown> = process.env): EnvConfig {
  const result = EnvSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Environment validation failed: ${JSON.stringify(result.error.format())}`);
  }
  return result.data;
}
