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
exports.TestAlertDto = exports.CreateAlertDto = void 0;
const class_validator_1 = require("class-validator");
const shared_1 = require("@quant/shared");
const class_transformer_1 = require("class-transformer");
class CreateAlertDto {
    channel; // 'TELEGRAM' | 'WEBHOOK' | 'EMAIL' | 'WEBPUSH'
    target; // chat_id, url, email, etc.
    minScore = 80;
    minGrade = shared_1.SignalGrade.A;
    isActive = true;
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
    (0, class_validator_1.IsNumber)(),
    (0, class_validator_1.Min)(0),
    (0, class_validator_1.Max)(100),
    (0, class_validator_1.IsOptional)(),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], CreateAlertDto.prototype, "minScore", void 0);
__decorate([
    (0, class_validator_1.IsEnum)(shared_1.SignalGrade),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], CreateAlertDto.prototype, "minGrade", void 0);
__decorate([
    (0, class_validator_1.IsBoolean)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", Boolean)
], CreateAlertDto.prototype, "isActive", void 0);
class TestAlertDto {
    channel;
    target;
    symbol = 'NIFTY';
}
exports.TestAlertDto = TestAlertDto;
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], TestAlertDto.prototype, "channel", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], TestAlertDto.prototype, "target", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsOptional)(),
    __metadata("design:type", String)
], TestAlertDto.prototype, "symbol", void 0);
//# sourceMappingURL=create-alert.dto.js.map