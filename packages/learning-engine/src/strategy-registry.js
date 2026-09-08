"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StrategyRegistry = void 0;
class StrategyRegistry {
    static strategies = new Map();
    static activeStrategyVersion = 'v2.0-smc-quant';
    static {
        const baseline = {
            strategyId: 'smc-quant-baseline',
            strategyVersion: 'v2.0-smc-quant',
            description: 'Baseline Institutional SMC + Quant Multi-Horizon Confluence Strategy',
            parameters: {
                minScore: 65,
                minMtfScore: 10,
                riskPerTradePercent: 1.0,
                useRegimeSizing: true,
            },
            expectancyR: 0.42,
            winRate: 58.5,
            profitFactor: 1.65,
            maxDrawdownPct: 12.0,
            status: 'ACTIVE',
            createdAt: new Date(),
            promotedAt: new Date(),
        };
        this.strategies.set(baseline.strategyVersion, baseline);
    }
    /**
     * Registers a new immutable strategy version.
     */
    static registerStrategy(entry) {
        this.strategies.set(entry.strategyVersion, Object.freeze({ ...entry }));
    }
    /**
     * Promotes a strategy version to ACTIVE.
     */
    static promoteStrategy(strategyVersion) {
        const current = this.strategies.get(this.activeStrategyVersion);
        if (current) {
            this.strategies.set(this.activeStrategyVersion, Object.freeze({ ...current, status: 'RETIRED' }));
        }
        const candidate = this.strategies.get(strategyVersion);
        if (!candidate) {
            throw new Error(`Strategy version ${strategyVersion} not found in registry.`);
        }
        this.strategies.set(strategyVersion, Object.freeze({ ...candidate, status: 'ACTIVE', promotedAt: new Date() }));
        this.activeStrategyVersion = strategyVersion;
    }
    /**
     * Reverts active strategy version.
     */
    static rollbackStrategy(targetVersion) {
        const current = this.strategies.get(this.activeStrategyVersion);
        if (current) {
            this.strategies.set(this.activeStrategyVersion, Object.freeze({ ...current, status: 'ROLLED_BACK' }));
        }
        const target = this.strategies.get(targetVersion);
        if (!target) {
            throw new Error(`Target strategy version ${targetVersion} not found in registry.`);
        }
        this.strategies.set(targetVersion, Object.freeze({ ...target, status: 'ACTIVE' }));
        this.activeStrategyVersion = targetVersion;
    }
    /**
     * Returns current active strategy.
     */
    static getActiveStrategy() {
        return this.strategies.get(this.activeStrategyVersion);
    }
    /**
     * Returns all strategies.
     */
    static getAllStrategies() {
        return Array.from(this.strategies.values());
    }
}
exports.StrategyRegistry = StrategyRegistry;
//# sourceMappingURL=strategy-registry.js.map