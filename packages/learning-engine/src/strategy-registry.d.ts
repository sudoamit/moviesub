export interface IStrategyRegistryEntry {
    strategyId: string;
    strategyVersion: string;
    description: string;
    parameters: Record<string, unknown>;
    expectancyR: number;
    winRate: number;
    profitFactor: number;
    maxDrawdownPct: number;
    status: 'ACTIVE' | 'CANDIDATE' | 'RETIRED' | 'ROLLED_BACK';
    createdAt: Date;
    promotedAt?: Date;
}
export declare class StrategyRegistry {
    private static strategies;
    private static activeStrategyVersion;
    /**
     * Registers a new immutable strategy version.
     */
    static registerStrategy(entry: IStrategyRegistryEntry): void;
    /**
     * Promotes a strategy version to ACTIVE.
     */
    static promoteStrategy(strategyVersion: string): void;
    /**
     * Reverts active strategy version.
     */
    static rollbackStrategy(targetVersion: string): void;
    /**
     * Returns current active strategy.
     */
    static getActiveStrategy(): IStrategyRegistryEntry | undefined;
    /**
     * Returns all strategies.
     */
    static getAllStrategies(): IStrategyRegistryEntry[];
}
