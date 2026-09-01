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
exports.CreateStrategyDto = exports.CreateAlertDto = exports.RunBacktestDto = exports.FilterScannerDto = void 0;
const class_validator_1 = require("class-validator");
const enums_1 = require("../enums");
class FilterScannerDto {
    timeframe;
    direction;
    minGrade;
    minScore;
    regime;
}
exports.FilterScannerDto = FilterScannerDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(enums_1.Timeframe),
    __metadata("design:type", String)
], FilterScannerDto.prototype, "timeframe", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(enums_1.Direction),
    __metadata("design:type", String)
], FilterScannerDto.prototype, "direction", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(enums_1.SignalGrade),
    __metadata("design:type", String)
], FilterScannerDto.prototype, "minGrade", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], FilterScannerDto.prototype, "minScore", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(enums_1.MarketRegimeType),
    __metadata("design:type", String)
], FilterScannerDto.prototype, "regime", void 0);
class RunBacktestDto {
    instrumentId;
    timeframe;
    startDate;
    endDate;
    initialCapital;
    riskPerTradePercent;
    minScore;
    strategyConfig;
}
exports.RunBacktestDto = RunBacktestDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], RunBacktestDto.prototype, "instrumentId", void 0);
__decorate([
    (0, class_validator_1.IsEnum)(enums_1.Timeframe),
    __metadata("design:type", String)
], RunBacktestDto.prototype, "timeframe", void 0);
__decorate([
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], RunBacktestDto.prototype, "startDate", void 0);
__decorate([
    (0, class_validator_1.IsDateString)(),
    __metadata("design:type", String)
], RunBacktestDto.prototype, "endDate", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(1000),
    __metadata("design:type", Number)
], RunBacktestDto.prototype, "initialCapital", void 0);
__decorate([
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0.1),
    (0, class_validator_1.Max)(10),
    __metadata("design:type", Number)
], RunBacktestDto.prototype, "riskPerTradePercent", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(50),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], RunBacktestDto.prototype, "minScore", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Object)
], RunBacktestDto.prototype, "strategyConfig", void 0);
class CreateAlertDto {
    channel;
    target;
    minScore;
    minGrade;
}
exports.CreateAlertDto = CreateAlertDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAlertDto.prototype, "channel", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateAlertDto.prototype, "target", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_validator_1.Max)(100),
    __metadata("design:type", Number)
], CreateAlertDto.prototype, "minScore", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(enums_1.SignalGrade),
    __metadata("design:type", String)
], CreateAlertDto.prototype, "minGrade", void 0);
class CreateStrategyDto {
    name;
    description;
    isDefault;
    configJson;
}
exports.CreateStrategyDto = CreateStrategyDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateStrategyDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateStrategyDto.prototype, "description", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Boolean)
], CreateStrategyDto.prototype, "isDefault", void 0);
//# sourceMappingURL=index.js.map