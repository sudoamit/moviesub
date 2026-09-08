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
exports.LearningController = void 0;
const common_1 = require("@nestjs/common");
const learning_service_1 = require("./learning.service");
let LearningController = class LearningController {
    learningService;
    constructor(learningService) {
        this.learningService = learningService;
    }
    async getSystemOverview() {
        return this.learningService.getSystemOverview();
    }
    async getExperiences(limit, symbol) {
        return this.learningService.getExperiences(limit ? parseInt(limit, 10) : 50, symbol);
    }
    async getErrorReport() {
        return this.learningService.getErrorReport();
    }
    async getPatterns() {
        return this.learningService.getPatterns();
    }
    async getCandidates() {
        return this.learningService.getCandidates();
    }
    async runLearningCycle(body) {
        return this.learningService.triggerLearningCycle(body?.autoPromote ?? false);
    }
    async promoteCandidate(id) {
        return this.learningService.promoteCandidate(id);
    }
    async rollback(body) {
        return this.learningService.rollback(body?.targetVersion);
    }
};
exports.LearningController = LearningController;
__decorate([
    (0, common_1.Get)('overview'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], LearningController.prototype, "getSystemOverview", null);
__decorate([
    (0, common_1.Get)('experiences'),
    __param(0, (0, common_1.Query)('limit')),
    __param(1, (0, common_1.Query)('symbol')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], LearningController.prototype, "getExperiences", null);
__decorate([
    (0, common_1.Get)('errors'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], LearningController.prototype, "getErrorReport", null);
__decorate([
    (0, common_1.Get)('patterns'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], LearningController.prototype, "getPatterns", null);
__decorate([
    (0, common_1.Get)('candidates'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], LearningController.prototype, "getCandidates", null);
__decorate([
    (0, common_1.Post)('run-cycle'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], LearningController.prototype, "runLearningCycle", null);
__decorate([
    (0, common_1.Post)('candidates/:id/promote'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], LearningController.prototype, "promoteCandidate", null);
__decorate([
    (0, common_1.Post)('rollback'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], LearningController.prototype, "rollback", null);
exports.LearningController = LearningController = __decorate([
    (0, common_1.Controller)('api/learning'),
    __metadata("design:paramtypes", [learning_service_1.LearningService])
], LearningController);
//# sourceMappingURL=learning.controller.js.map