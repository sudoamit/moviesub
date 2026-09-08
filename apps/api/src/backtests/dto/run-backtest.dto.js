"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunBacktestDto = void 0;
const class_validator_1 = require("class-validator");
const class_transformer_1 = require("class-transformer");
const shared_1 = require("@quant/shared");
class RunBacktestDto {
    symbol;
    timeframe = shared_1.Timeframe.M15;
    initialCapital = 100000;
    riskPerTradePercent = 1.0;
    minScore = 65;
    limit = 300;
}
exports.RunBacktestDto = RunBacktestDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], RunBacktestDto.prototype, "symbol", void 0);
__decorate([
    (0, class_validator_1.IsEnum)(shared_1.Timeframe),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], RunBacktestDto.prototype, "timeframe", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsPositive)(),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], RunBacktestDto.prototype, "initialCapital", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsPositive)(),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], RunBacktestDto.prototype, "riskPerTradePercent", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.Min)(0),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], RunBacktestDto.prototype, "minScore", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.Min)(50),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], RunBacktestDto.prototype, "limit", void 0);
//# sourceMappingURL=run-backtest.dto.js.map