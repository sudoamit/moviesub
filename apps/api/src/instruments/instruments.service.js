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
var InstrumentsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.InstrumentsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../common/prisma/prisma.service");
let InstrumentsService = InstrumentsService_1 = class InstrumentsService {
    prisma;
    logger = new common_1.Logger(InstrumentsService_1.name);
    constructor(prisma) {
        this.prisma = prisma;
    }
    async findAll(activeOnly = true) {
        const instruments = await this.prisma.instrument.findMany({
            where: activeOnly ? { isActive: true } : {},
            orderBy: { symbol: 'asc' },
        });
        return instruments.map((inst) => ({
            id: inst.id,
            symbol: inst.symbol,
            name: inst.name,
            exchange: inst.exchange,
            assetType: inst.assetType,
            tickSize: Number(inst.tickSize),
            lotSize: inst.lotSize,
            contractSize: Number(inst.contractSize),
            currency: inst.currency,
            tradingHoursJson: inst.tradingHoursJson,
            isActive: inst.isActive,
            createdAt: inst.createdAt,
            updatedAt: inst.updatedAt,
        }));
    }
    async findBySymbol(symbol) {
        const inst = await this.prisma.instrument.findUnique({
            where: { symbol: symbol.toUpperCase() },
        });
        if (!inst)
            return null;
        return {
            id: inst.id,
            symbol: inst.symbol,
            name: inst.name,
            exchange: inst.exchange,
            assetType: inst.assetType,
            tickSize: Number(inst.tickSize),
            lotSize: inst.lotSize,
            contractSize: Number(inst.contractSize),
            currency: inst.currency,
            tradingHoursJson: inst.tradingHoursJson,
            isActive: inst.isActive,
            createdAt: inst.createdAt,
            updatedAt: inst.updatedAt,
        };
    }
};
exports.InstrumentsService = InstrumentsService;
exports.InstrumentsService = InstrumentsService = InstrumentsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], InstrumentsService);
//# sourceMappingURL=instruments.service.js.map