"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const app_module_1 = require("./app.module");
const all_exceptions_filter_1 = require("./common/filters/all-exceptions.filter");
const logging_interceptor_1 = require("./common/interceptors/logging.interceptor");
async function bootstrap() {
    const logger = new common_1.Logger('Bootstrap');
    const app = await core_1.NestFactory.create(app_module_1.AppModule, {
        logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    });
    const port = process.env.PORT || 3001;
    const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:3000';
    app.enableCors({
        origin: corsOrigin.split(','),
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        credentials: true,
    });
    app.useGlobalPipes(new common_1.ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: {
            enableImplicitConversion: true,
        },
    }));
    app.useGlobalFilters(new all_exceptions_filter_1.AllExceptionsFilter());
    app.useGlobalInterceptors(new logging_interceptor_1.LoggingInterceptor());
    await app.listen(port);
    logger.log(`====================================================`);
    logger.log(`🚀 Quantitative Trading API running on port ${port}`);
    logger.log(`📡 Health Check: http://localhost:${port}/health`);
    logger.log(`📡 Readiness Check: http://localhost:${port}/ready`);
    logger.log(`📡 Instruments API: http://localhost:${port}/api/instruments`);
    logger.log(`====================================================`);
}
bootstrap().catch((err) => {
    console.error('Fatal error starting NestJS API:', err);
    process.exit(1);
});
//# sourceMappingURL=main.js.map