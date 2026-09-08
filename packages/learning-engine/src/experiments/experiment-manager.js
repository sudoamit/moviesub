"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuantExperimentManager = void 0;
class QuantExperimentManager {
    experiments = new Map();
    registerExperiment(record) {
        this.experiments.set(record.experimentId, record);
    }
    getExperiment(experimentId) {
        return this.experiments.get(experimentId);
    }
    listExperiments() {
        return Array.from(this.experiments.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    getBestExperimentByOOSExpectancy() {
        const list = this.listExperiments().filter((e) => e.isRobust);
        if (list.length === 0)
            return undefined;
        return list.sort((a, b) => b.oosMetrics.expectancyR - a.oosMetrics.expectancyR)[0];
    }
}
exports.QuantExperimentManager = QuantExperimentManager;
//# sourceMappingURL=experiment-manager.js.map