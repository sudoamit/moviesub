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
exports.ResearchController = void 0;
const common_1 = require("@nestjs/common");
const research_service_1 = require("./research.service");
let ResearchController = class ResearchController {
    researchService;
    constructor(researchService) {
        this.researchService = researchService;
    }
    async getScorecard() {
        return this.researchService.getScorecard();
    }
    async getHypotheses() {
        return this.researchService.getHypotheses();
    }
    async getExperiments() {
        return this.researchService.getExperiments();
    }
    async runExperiment(body) {
        return this.researchService.runExperiment(body);
    }
    async getKnowledgeGraph() {
        return this.researchService.getKnowledgeGraph();
    }
    async runAblation(body) {
        return this.researchService.runAblation(body?.symbol || 'NIFTY', body?.timeframe || '15m');
    }
    async getCounterfactuals() {
        return this.researchService.getCounterfactuals();
    }
};
exports.ResearchController = ResearchController;
__decorate([
    (0, common_1.Get)('scorecard'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ResearchController.prototype, "getScorecard", null);
__decorate([
    (0, common_1.Get)('hypotheses'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ResearchController.prototype, "getHypotheses", null);
__decorate([
    (0, common_1.Get)('experiments'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ResearchController.prototype, "getExperiments", null);
__decorate([
    (0, common_1.Post)('run-experiment'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ResearchController.prototype, "runExperiment", null);
__decorate([
    (0, common_1.Get)('knowledge-graph'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ResearchController.prototype, "getKnowledgeGraph", null);
__decorate([
    (0, common_1.Post)('ablation'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], ResearchController.prototype, "runAblation", null);
__decorate([
    (0, common_1.Get)('counterfactuals'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ResearchController.prototype, "getCounterfactuals", null);
exports.ResearchController = ResearchController = __decorate([
    (0, common_1.Controller)('api/research'),
    __metadata("design:paramtypes", [research_service_1.ResearchService])
], ResearchController);
//# sourceMappingURL=research.controller.js.map