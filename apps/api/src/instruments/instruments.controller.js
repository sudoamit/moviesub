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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InstrumentsController = void 0;
const common_1 = require("@nestjs/common");
const instruments_service_1 = require("./instruments.service");
let InstrumentsController = class InstrumentsController {
    instrumentsService;
    constructor(instrumentsService) {
        this.instrumentsService = instrumentsService;
    }
    async getInstruments() {
        return this.instrumentsService.findAll();
    }
    async getInstrument(symbol) {
        const instrument = await this.instrumentsService.findBySymbol(symbol);
        if (!instrument) {
            throw new common_1.NotFoundException(`Instrument with symbol '${symbol}' not found`);
        }
        return instrument;
    }
};
exports.InstrumentsController = InstrumentsController;
__decorate([
    (0, common_1.Get)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], InstrumentsController.prototype, "getInstruments", null);
__decorate([
    (0, common_1.Get)(':symbol'),
    __param(0, (0, common_1.Param)('symbol')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], InstrumentsController.prototype, "getInstrument", null);
exports.InstrumentsController = InstrumentsController = __decorate([
    (0, common_1.Controller)('api/instruments'),
    __metadata("design:paramtypes", [instruments_service_1.InstrumentsService])
], InstrumentsController);
//# sourceMappingURL=instruments.controller.js.map