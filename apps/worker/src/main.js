"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const worker_module_1 = require("./worker.module");
async function bootstrap() {
    const logger = new common_1.Logger('WorkerBootstrap');
    const app = await core_1.NestFactory.createApplicationContext(worker_module_1.WorkerModule, {
        logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    });
    logger.log('====================================================');
    logger.log('⚙️  Quant Background BullMQ Worker started');
    logger.log('====================================================');
    // Handle graceful shutdown
    const shutdown = async () => {
        logger.log('Shutting down BullMQ Worker gracefully...');
        await app.close();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
bootstrap().catch((err) => {
    console.error('Fatal error starting BullMQ Worker:', err);
    process.exit(1);
});
//# sourceMappingURL=main.js.map