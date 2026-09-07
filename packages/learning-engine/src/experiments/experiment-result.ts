export interface IExperimentMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  expectancyR: number;
  sharpeRatio: number;
  maxDrawdownPercent: number;
  brierScore?: number;
  logLoss?: number;
  aucRoc?: number;
  calmarRatio?: number;
  sortinoRatio?: number;
}

export interface IExperimentStressResult {
  multiplier: number; // 1.0x, 1.5x, 2.0x, 3.0x
  netExpectancyR: number;
  profitFactor: number;
  survived: boolean;
}

export interface IExperimentRecord {
  experimentId: string;
  name: string;
  strategyVersion: string;
  modelVersion: string;
  featureVersion: string;
  datasetVersion: string;
  datasetHash: string;
  parameters: Record<string, any>;
  trainingPeriod: { start: string; end: string; samples: number };
  validationPeriod: { start: string; end: string; samples: number };
  oosPeriod: { start: string; end: string; samples: number };
  trainMetrics: IExperimentMetrics;
  validationMetrics: IExperimentMetrics;
  oosMetrics: IExperimentMetrics;
  costStressTests: IExperimentStressResult[];
  monteCarloRuinProbability: number;
  monteCarlo95Drawdown: number;
  randomSeed: number;
  isRobust: boolean;
  rejectionReasons?: string[];
  createdAt: string;
}
