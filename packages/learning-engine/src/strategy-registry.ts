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

export class StrategyRegistry {
  private static strategies: Map<string, IStrategyRegistryEntry> = new Map();
  private static activeStrategyVersion = 'v2.0-smc-quant';

  static {
    const baseline: IStrategyRegistryEntry = {
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
  public static registerStrategy(entry: IStrategyRegistryEntry): void {
    this.strategies.set(entry.strategyVersion, Object.freeze({ ...entry }));
  }

  /**
   * Promotes a strategy version to ACTIVE.
   */
  public static promoteStrategy(strategyVersion: string): void {
    const current = this.strategies.get(this.activeStrategyVersion);
    if (current) {
      current.status = 'RETIRED';
    }

    const candidate = this.strategies.get(strategyVersion);
    if (!candidate) {
      throw new Error(`Strategy version ${strategyVersion} not found in registry.`);
    }

    candidate.status = 'ACTIVE';
    candidate.promotedAt = new Date();
    this.activeStrategyVersion = strategyVersion;
  }

  /**
   * Reverts active strategy version.
   */
  public static rollbackStrategy(targetVersion: string): void {
    const current = this.strategies.get(this.activeStrategyVersion);
    if (current) {
      current.status = 'ROLLED_BACK';
    }

    const target = this.strategies.get(targetVersion);
    if (!target) {
      throw new Error(`Target strategy version ${targetVersion} not found in registry.`);
    }

    target.status = 'ACTIVE';
    this.activeStrategyVersion = targetVersion;
  }

  /**
   * Returns current active strategy.
   */
  public static getActiveStrategy(): IStrategyRegistryEntry | undefined {
    return this.strategies.get(this.activeStrategyVersion);
  }

  /**
   * Returns all strategies.
   */
  public static getAllStrategies(): IStrategyRegistryEntry[] {
    return Array.from(this.strategies.values());
  }
}
