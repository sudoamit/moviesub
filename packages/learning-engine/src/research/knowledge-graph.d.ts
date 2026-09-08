import { TradingExperience } from '../types';
import { KnowledgeGraph } from './types';
export declare class KnowledgeGraphEngine {
    private static nodes;
    private static edges;
    /**
     * Rebuilds or updates the multidimensional Knowledge Graph from trading experiences.
     */
    static buildFromExperiences(experiences: TradingExperience[]): KnowledgeGraph;
    private static upsertNode;
    private static upsertEdge;
    static getGraph(): KnowledgeGraph;
    static clear(): void;
}
