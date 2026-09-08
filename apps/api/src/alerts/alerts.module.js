"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlertsModule = void 0;
const common_1 = require("@nestjs/common");
const alerts_controller_1 = require("./alerts.controller");
const alerts_service_1 = require("./alerts.service");
const telegram_dispatcher_1 = require("./dispatcher/telegram.dispatcher");
const webhook_dispatcher_1 = require("./dispatcher/webhook.dispatcher");
const rate_limiter_1 = require("./dispatcher/rate-limiter");
const signals_module_1 = require("../signals/signals.module");
let AlertsModule = class AlertsModule {
};
exports.AlertsModule = AlertsModule;
exports.AlertsModule = AlertsModule = __decorate([
    (0, common_1.Module)({
        imports: [signals_module_1.SignalsModule],
        controllers: [alerts_controller_1.AlertsController],
        providers: [alerts_service_1.AlertsService, telegram_dispatcher_1.TelegramDispatcher, webhook_dispatcher_1.WebhookDispatcher, rate_limiter_1.AlertRateLimiter],
        exports: [alerts_service_1.AlertsService],
    })
], AlertsModule);
//# sourceMappingURL=alerts.module.js.map