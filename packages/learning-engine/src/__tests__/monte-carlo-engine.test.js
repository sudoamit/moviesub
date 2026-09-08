"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const monte_carlo_engine_1 = require("../monte-carlo-engine");
describe('MonteCarloEngine', () => {
    it('should run 1000 iterations of bootstrap simulation', () => {
        // 50 historical trade R-multiples (60% win rate, average win 2.5R, average loss 1R)
        const rMultiples = Array.from({ length: 50 }, (_, i) => (i % 5 < 3 ? 2.5 : -1.0));
        const res = monte_carlo_engine_1.MonteCarloEngine.simulate(rMultiples, {
            iterations: 1000,
            ruinThresholdDrawdownR: 15.0,
        });
        expect(res.iterations).toBe(1000);
        expect(res.probabilityOfRuin).toBeLessThanOrEqual(0.05);
        expect(res.medianExpectancyR).toBeGreaterThan(0);
        expect(res.maxDrawdown95Pct).toBeGreaterThan(0);
        expect(res.isRobust).toBe(true);
    });
});
//# sourceMappingURL=monte-carlo-engine.test.js.map