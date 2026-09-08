import { TradingExperience } from './types';
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
export declare class ExperienceStore {
    private static experiences;
    /**
     * Appends an immutable TradingExperience.
     */
    static saveExperience(exp: TradingExperience): TradingExperience;
    /**
     * Bulk loads or seeds experiences into the store.
     */
    static loadExperiences(exps: TradingExperience[]): void;
    /**
     * Persists all experiences in store to a JSON file.
     */
    static saveToFile(filePath: string): void;
    /**
     * Loads experiences from a JSON file into the store.
     */
    static loadFromFile(filePath: string): void;
    /**
     * Retrieves a single experience by ID.
     */
    static getById(id: string): TradingExperience | undefined;
    /**
     * Retrieves all completed experiences matching query filters.
     */
    static query(filter?: IExperienceFilter): TradingExperience[];
    /**
     * Count total experiences in memory.
     */
    static count(): number;
    /**
     * Clears the in-memory experience cache (useful for isolated tests).
     */
    static clear(): void;
}
