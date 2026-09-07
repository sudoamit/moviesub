import { TradingExperience } from '../types';
import { KnowledgeGraph, KnowledgeGraphEdge, KnowledgeGraphNode } from './types';

export class KnowledgeGraphEngine {
  private static nodes: Map<string, KnowledgeGraphNode> = new Map();
  private static edges: Map<string, KnowledgeGraphEdge> = new Map();

  /**
   * Rebuilds or updates the multidimensional Knowledge Graph from trading experiences.
   */
  public static buildFromExperiences(experiences: TradingExperience[]): KnowledgeGraph {
    for (const exp of experiences) {
      const regimeName = exp.marketContext?.regime || 'UNKNOWN_REGIME';
      const setupName =
        exp.decision?.action === 'BUY'
          ? 'BULLISH_ORDER_FLOW'
          : exp.decision?.action === 'SELL'
            ? 'BEARISH_ORDER_FLOW'
            : 'CONSOLIDATION_HOLD';
      const entryQuality = exp.failureReasons?.includes('LATE_ENTRY')
        ? 'LATE_ENTRY'
        : exp.failureReasons?.includes('EARLY_ENTRY')
          ? 'EARLY_ENTRY'
          : 'OPTIMAL_ENTRY';
      const outcomeStatus = exp.outcome?.status || 'UNKNOWN';

      // 1. Regime Node
      const regimeNodeId = `node_regime_${regimeName}`;
      this.upsertNode(regimeNodeId, 'REGIME', regimeName, exp);

      // 2. Setup Node
      const setupNodeId = `node_setup_${setupName}`;
      this.upsertNode(setupNodeId, 'SETUP', setupName, exp);

      // 3. Entry Quality Node
      const entryNodeId = `node_entry_${entryQuality}`;
      this.upsertNode(entryNodeId, 'ENTRY_QUALITY', entryQuality, exp);

      // 4. Outcome Node
      const outcomeNodeId = `node_outcome_${outcomeStatus}`;
      this.upsertNode(outcomeNodeId, 'OUTCOME', outcomeStatus, exp);

      // Connect Edges
      this.upsertEdge(regimeNodeId, setupNodeId, 'TRIGGERS');
      this.upsertEdge(setupNodeId, entryNodeId, 'CORRELATES_WITH');
      this.upsertEdge(
        entryNodeId,
        outcomeNodeId,
        outcomeStatus === 'LOSS' ? 'CAUSES_FAILURE' : 'AMPLIFIES',
      );
    }

    return this.getGraph();
  }

  private static upsertNode(
    id: string,
    type: KnowledgeGraphNode['type'],
    name: string,
    exp: TradingExperience,
  ): void {
    const existing = this.nodes.get(id);
    const pnlR = exp.outcome?.pnlR || 0;
    const isWin = pnlR > 0;

    if (existing) {
      existing.frequency += 1;
      const totalR = existing.averageR * (existing.frequency - 1) + pnlR;
      existing.averageR = Number((totalR / existing.frequency).toFixed(3));
      const winsCount =
        Math.round((existing.winRate / 100) * (existing.frequency - 1)) + (isWin ? 1 : 0);
      existing.winRate = Number(((winsCount / existing.frequency) * 100).toFixed(1));
    } else {
      this.nodes.set(id, {
        id,
        type,
        name,
        properties: {},
        frequency: 1,
        averageR: pnlR,
        winRate: isWin ? 100.0 : 0.0,
      });
    }
  }

  private static upsertEdge(
    sourceId: string,
    targetId: string,
    relationship: KnowledgeGraphEdge['relationship'],
  ): void {
    const edgeId = `${sourceId}_-->_${targetId}`;
    const existing = this.edges.get(edgeId);

    if (existing) {
      existing.sampleCount += 1;
      existing.weight = Math.min(1.0, existing.sampleCount / 50.0);
    } else {
      this.edges.set(edgeId, {
        id: edgeId,
        sourceNodeId: sourceId,
        targetNodeId: targetId,
        relationship,
        weight: 0.1,
        sampleCount: 1,
        pVal: 0.05,
      });
    }
  }

  public static getGraph(): KnowledgeGraph {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
      lastUpdated: new Date(),
    };
  }

  public static clear(): void {
    this.nodes.clear();
    this.edges.clear();
  }
}
