"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var RedisService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisService = void 0;
const common_1 = require("@nestjs/common");
const ioredis_1 = __importDefault(require("ioredis"));
let RedisService = RedisService_1 = class RedisService {
    logger = new common_1.Logger(RedisService_1.name);
    client;
    onModuleInit() {
        const host = process.env.REDIS_HOST || 'localhost';
        const port = Number(process.env.REDIS_PORT) || 6380;
        const password = process.env.REDIS_PASSWORD || undefined;
        this.client = new ioredis_1.default({
            host,
            port,
            password,
            lazyConnect: true,
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
                const delay = Math.min(times * 100, 3000);
                return delay;
            },
        });
        this.client.on('connect', () => {
            this.logger.log(`Redis connected on ${host}:${port}`);
        });
        this.client.on('error', (err) => {
            this.logger.warn(`Redis connection error: ${err.message}`);
        });
        this.client.connect().catch((err) => {
            this.logger.warn(`Initial Redis connection failed: ${err.message}`);
        });
    }
    async onModuleDestroy() {
        if (this.client) {
            await this.client.quit();
            this.logger.log('Redis client disconnected');
        }
    }
    getClient() {
        return this.client;
    }
    async isHealthy() {
        try {
            if (!this.client || this.client.status !== 'ready') {
                return false;
            }
            const pong = await this.client.ping();
            return pong === 'PONG';
        }
        catch (error) {
            return false;
        }
    }
    async get(key) {
        try {
            return await this.client.get(key);
        }
        catch (error) {
            this.logger.error(`Redis get error for key ${key}:`, error);
            return null;
        }
    }
    async set(key, value, ttlSeconds) {
        try {
            if (ttlSeconds) {
                await this.client.set(key, value, 'EX', ttlSeconds);
            }
            else {
                await this.client.set(key, value);
            }
        }
        catch (error) {
            this.logger.error(`Redis set error for key ${key}:`, error);
        }
    }
    async del(key) {
        try {
            await this.client.del(key);
        }
        catch (error) {
            this.logger.error(`Redis del error for key ${key}:`, error);
        }
    }
};
exports.RedisService = RedisService;
exports.RedisService = RedisService = RedisService_1 = __decorate([
    (0, common_1.Injectable)()
], RedisService);
//# sourceMappingURL=redis.service.js.map