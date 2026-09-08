import * as fs from 'fs';
import { TradingExperience } from './types';
import { PointInTimeValidator } from './point-in-time-validator';

export interface IExperienceFilter {
  symbol?: string;
  assetType?: string;
  regime?: string;
  session?: string;
  outcomeClassification?: string;
  outcomeStatus?: 'WIN' | 'LOSS' | 'TIMEOUT' | 'SCRATCH';
  startDate?: Date;
  endDate?: Date;
  minScore?: number;
  strategyVersion?: string;
}

export class ExperienceStore {
  private static experiences: Map<string, TradingExperience> = new Map();

  /**
   * Appends an immutable TradingExperience.
   */
  public static saveExperience(exp: TradingExperience): TradingExperience {
    if (this.experiences.has(exp.id)) {
      throw new Error(
        `TradingExperience with id ${exp.id} already exists (Immutability Violation).`,
      );
    }

    const valResult = PointInTimeValidator.validatePointInTimeExperience(exp);
    if (!valResult.isValid) {
      throw new Error(`Point-In-Time Experience Invariant Violation: ${valResult.reason}`);
    }

    const prepared: TradingExperience = {
      ...exp,
      decisionTimestamp: valResult.decisionTimestamp,
      featureTimestamp: valResult.featureTimestamp,
      labelStartTimestamp: valResult.labelStartTimestamp,
      labelEndTimestamp: valResult.labelEndTimestamp,
    };

    const frozen = Object.freeze(prepared);
    this.experiences.set(exp.id, frozen);
    return frozen;
  }

  /**
   * Bulk loads or seeds experiences into the store.
   */
  public static loadExperiences(exps: TradingExperience[]): void {
    for (const exp of exps) {
      if (!this.experiences.has(exp.id)) {
        const valResult = PointInTimeValidator.validatePointInTimeExperience(exp);
        if (valResult.isValid) {
          const prepared: TradingExperience = {
            ...exp,
            decisionTimestamp: valResult.decisionTimestamp,
            featureTimestamp: valResult.featureTimestamp,
            labelStartTimestamp: valResult.labelStartTimestamp,
            labelEndTimestamp: valResult.labelEndTimestamp,
          };
          this.experiences.set(exp.id, Object.freeze(prepared));
        }
      }
    }
  }

  /**
   * Persists all experiences in store to a JSON file.
   */
  public static saveToFile(filePath: string): void {
    const list = Array.from(this.experiences.values());
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf-8');
  }

  /**
   * Loads experiences from a JSON file into the store.
   */
  public static loadFromFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as TradingExperience[];
    this.loadExperiences(parsed);
  }

  /**
   * Retrieves a single experience by ID.
   */
  public static getById(id: string): TradingExperience | undefined {
    return this.experiences.get(id);
  }

  /**
   * Retrieves all completed experiences matching query filters.
   */
  public static query(filter: IExperienceFilter = {}): TradingExperience[] {
    const all = Array.from(this.experiences.values());

    return all
      .filter((exp) => {
        if (filter.symbol && exp.instrument.symbol.toUpperCase() !== filter.symbol.toUpperCase())
          return false;
        if (filter.assetType && exp.instrument.assetType !== filter.assetType) return false;
        if (filter.regime && exp.marketContext.regime !== filter.regime) return false;
        if (filter.session && exp.marketContext.session !== filter.session) return false;
        if (
          filter.outcomeClassification &&
          exp.outcomeClassification !== filter.outcomeClassification
        )
          return false;
        if (filter.outcomeStatus && exp.outcome.status !== filter.outcomeStatus) return false;
        if (filter.strategyVersion && exp.strategyVersion !== filter.strategyVersion) return false;
        if (filter.minScore !== undefined && exp.decision.score < filter.minScore) return false;
        if (
          filter.startDate &&
          new Date(exp.timestamp).getTime() < new Date(filter.startDate).getTime()
        )
          return false;
        if (
          filter.endDate &&
          new Date(exp.timestamp).getTime() > new Date(filter.endDate).getTime()
        )
          return false;
        return true;
      })
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  /**
   * Count total experiences in memory.
   */
  public static count(): number {
    return this.experiences.size;
  }

  /**
   * Clears the in-memory experience cache (useful for isolated tests).
   */
  public static clear(): void {
    this.experiences.clear();
  }
}
