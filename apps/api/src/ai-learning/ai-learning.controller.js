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
exports.AILearningController = void 0;
const common_1 = require("@nestjs/common");
const ai_learning_service_1 = require("./ai-learning.service");
let AILearningController = class AILearningController {
    aiLearningService;
    constructor(aiLearningService) {
        this.aiLearningService = aiLearningService;
    }
    /**
     * 1. GET /api/ai-learning/model-state
     * Returns active model version, schema version, trained timestamp, metrics, and calibration.
     */
    async getModelState() {
        return this.aiLearningService.getModelState();
    }
    /**
     * 2. POST /api/ai-learning/retrain
     * Starts a non-blocking background training job.
     */
    async startRetrainJob() {
        return this.aiLearningService.startRetrainJob();
    }
    /**
     * 3. GET /api/ai-learning/retrain/:jobId
     * Returns status, progress percent, stage, and candidate metrics of a training job.
     */
    async getRetrainJobStatus(jobId) {
        return this.aiLearningService.getRetrainJobStatus(jobId);
    }
    /**
     * 4. POST /api/ai-learning/predict
     * Evaluates a trade setup using genuine trading engine features.
     */
    async predictTrade(dto) {
        return this.aiLearningService.predictTrade(dto);
    }
    /**
     * 5. GET /api/ai-learning/insights
     * Returns feature importance, regime breakdowns, asset performance, and post-mortems.
     */
    async getInsights() {
        return this.aiLearningService.getInsights();
    }
};
exports.AILearningController = AILearningController;
__decorate([
    (0, common_1.Get)('model-state'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AILearningController.prototype, "getModelState", null);
__decorate([
    (0, common_1.Post)('retrain'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AILearningController.prototype, "startRetrainJob", null);
__decorate([
    (0, common_1.Get)('retrain/:jobId'),
    __param(0, (0, common_1.Param)('jobId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AILearningController.prototype, "getRetrainJobStatus", null);
__decorate([
    (0, common_1.Post)('predict'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [ai_learning_service_1.PredictTradeDto]),
    __metadata("design:returntype", Promise)
], AILearningController.prototype, "predictTrade", null);
__decorate([
    (0, common_1.Get)('insights'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AILearningController.prototype, "getInsights", null);
exports.AILearningController = AILearningController = __decorate([
    (0, common_1.Controller)('api/ai-learning'),
    __metadata("design:paramtypes", [ai_learning_service_1.AILearningService])
], AILearningController);
//# sourceMappingURL=ai-learning.controller.js.map