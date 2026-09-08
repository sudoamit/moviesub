"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RobustnessEngine = void 0;
const candidate_evaluator_1 = require("./candidate-evaluator");
class RobustnessEngine {
    /**
     * Stress tests candidate strategies against aggressive transaction costs, slippage, and spread widening.
     */
    static evaluateCosts(candidate, experiences) {
        // 1. Normal Cost: 0.05R
        const normal = candidate_evaluator_1.CandidateEvaluator.evaluate(candidate, experiences, 0.05);
        // 2. Double Cost: 0.10R
        const doubleCost = candidate_evaluator_1.CandidateEvaluator.evaluate(candidate, experiences, 0.1);
        // 3. Triple Cost (Stress): 0.15R
        const tripleCost = candidate_evaluator_1.CandidateEvaluator.evaluate(candidate, experiences, 0.15);
        const normalExp = normal.candidateExpectancy;
        const doubleExp = doubleCost.candidateExpectancy;
        const tripleExp = tripleCost.candidateExpectancy;
        const survivedDouble = doubleExp > 0.05;
        const survivedTriple = tripleExp > 0.0;
        // Estimate Breakeven Transaction Cost in R
        const breakEvenCostR = Math.max(0, Number((normalExp + 0.05).toFixed(3)));
        const isRobust = survivedDouble && breakEvenCostR >= 0.12;
        return {
            candidateId: candidate.id,
            normalCostExpectancy: normalExp,
            doubleCostExpectancy: doubleExp,
            tripleCostExpectancy: tripleExp,
            survivedDoubleCosts: survivedDouble,
            survivedTripleCosts: survivedTriple,
            breakEvenCostR,
            isRobust,
        };
    }
}
exports.RobustnessEngine = RobustnessEngine;
//# sourceMappingURL=robustness-engine.js.map