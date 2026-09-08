"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KnowledgeGraphEngine = void 0;
class KnowledgeGraphEngine {
    static nodes = new Map();
    static edges = new Map();
    /**
     * Rebuilds or updates the multidimensional Knowledge Graph from trading experiences.
     */
    static buildFromExperiences(experiences) {
        for (const exp of experiences) {
            const regimeName = exp.marketContext?.regime || 'UNKNOWN_REGIME';
            const setupName = exp.decision?.action === 'BUY'
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
            this.upsertEdge(entryNodeId, outcomeNodeId, outcomeStatus === 'LOSS' ? 'CAUSES_FAILURE' : 'AMPLIFIES');
        }
        return this.getGraph();
    }
    static upsertNode(id, type, name, exp) {
        const existing = this.nodes.get(id);
        const pnlR = exp.outcome?.pnlR || 0;
        const isWin = pnlR > 0;
        if (existing) {
            existing.frequency += 1;
            const totalR = existing.averageR * (existing.frequency - 1) + pnlR;
            existing.averageR = Number((totalR / existing.frequency).toFixed(3));
            const winsCount = Math.round((existing.winRate / 100) * (existing.frequency - 1)) + (isWin ? 1 : 0);
            existing.winRate = Number(((winsCount / existing.frequency) * 100).toFixed(1));
        }
        else {
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
    static upsertEdge(sourceId, targetId, relationship) {
        const edgeId = `${sourceId}_-->_${targetId}`;
        const existing = this.edges.get(edgeId);
        if (existing) {
            existing.sampleCount += 1;
            existing.weight = Math.min(1.0, existing.sampleCount / 50.0);
        }
        else {
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
    static getGraph() {
        return {
            nodes: Array.from(this.nodes.values()),
            edges: Array.from(this.edges.values()),
            lastUpdated: new Date(),
        };
    }
    static clear() {
        this.nodes.clear();
        this.edges.clear();
    }
}
exports.KnowledgeGraphEngine = KnowledgeGraphEngine;
//# sourceMappingURL=knowledge-graph.js.map