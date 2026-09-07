import * as crypto from 'crypto';
import { ExperimentStatus, ResearchExperiment } from './types';

export class ExperimentRegistry {
  private static experiments: Map<string, ResearchExperiment> = new Map();

  /**
   * Generates a deterministic SHA-256 hash identifying the exact experiment configuration.
   * Ensures identical parameters, datasets, and period windows produce the exact same hash.
   */
  public static computeExperimentHash(config: {
    datasetVersion: string;
    strategyVersion: string;
    featureSchemaVersion: string;
    instrument: string;
    timeframe: string;
    parameters: Record<string, unknown>;
    trainingPeriod: { start: Date; end: Date };
    validationPeriod: { start: Date; end: Date };
    testPeriod: { start: Date; end: Date };
    holdoutPeriod?: { start: Date; end: Date };
  }): string {
    const payload = JSON.stringify({
      datasetVersion: config.datasetVersion,
      strategyVersion: config.strategyVersion,
      featureSchemaVersion: config.featureSchemaVersion,
      instrument: config.instrument.toUpperCase(),
      timeframe: config.timeframe,
      parameters: config.parameters,
      trainStart: config.trainingPeriod.start.toISOString(),
      trainEnd: config.trainingPeriod.end.toISOString(),
      valStart: config.validationPeriod.start.toISOString(),
      valEnd: config.validationPeriod.end.toISOString(),
      testStart: config.testPeriod.start.toISOString(),
      testEnd: config.testPeriod.end.toISOString(),
      holdoutStart: config.holdoutPeriod?.start.toISOString() || null,
      holdoutEnd: config.holdoutPeriod?.end.toISOString() || null,
    });

    return crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);
  }

  /**
   * Registers a new research experiment into the immutable registry.
   */
  public static registerExperiment(experiment: ResearchExperiment): ResearchExperiment {
    if (this.experiments.has(experiment.id)) {
      throw new Error(`Experiment with ID '${experiment.id}' already exists in registry.`);
    }
    this.experiments.set(experiment.id, experiment);
    return experiment;
  }

  /**
   * Finds an existing experiment by its deterministic configuration hash.
   */
  public static findExperimentByHash(hash: string): ResearchExperiment | undefined {
    for (const exp of this.experiments.values()) {
      if (exp.experimentHash === hash) {
        return exp;
      }
    }
    return undefined;
  }

  public static getExperiment(id: string): ResearchExperiment | undefined {
    return this.experiments.get(id);
  }

  public static listExperiments(limit = 100): ResearchExperiment[] {
    return Array.from(this.experiments.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  public static getExperimentsByStatus(status: ExperimentStatus): ResearchExperiment[] {
    return Array.from(this.experiments.values()).filter((e) => e.status === status);
  }

  public static updateExperiment(
    id: string,
    updates: Partial<ResearchExperiment>,
  ): ResearchExperiment {
    const existing = this.experiments.get(id);
    if (!existing) {
      throw new Error(`Experiment with ID '${id}' not found.`);
    }
    const updated = { ...existing, ...updates };
    this.experiments.set(id, updated);
    return updated;
  }

  public static clear(): void {
    this.experiments.clear();
  }
}
