"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CandidateGenerator = void 0;
class CandidateGenerator {
    static candidateSeq = 1;
    /**
     * Translates error reports and discovered patterns into structured machine-readable Strategy Candidates.
     */
    static generateCandidates(inputs) {
        const candidates = [];
        const baseVersion = inputs.baseStrategyVersion || 'v2.0';
        // 1. Generate Filter Candidates from Negative Patterns
        const negativePatterns = inputs.patterns.filter((p) => p.type === 'NEGATIVE_FILTER');
        for (const pat of negativePatterns) {
            const candidateVersion = `${baseVersion}-cand-neg-${this.candidateSeq++}`;
            const filterDesc = `Reject setups matching loss-inducing condition: [${pat.conditions.join(' AND ')}]`;
            candidates.push({
                id: `cand-${Date.now()}-${this.candidateSeq}`,
                baseStrategyVersion: baseVersion,
                candidateVersion,
                type: 'FILTER',
                description: filterDesc,
                change: {
                    action: 'ADD_FILTER_RULE',
                    conditionRules: pat.conditions,
                    rejectWhenMatched: true,
                },
                evidence: {
                    sampleSize: pat.sampleSize,
                    expectancyBefore: pat.expectancy,
                    expectancyAfterHistorical: pat.expectancy, // Initialized to baseline prior to actual simulation
                    confidenceInterval: pat.confidenceInterval,
                    pValue: pat.pVal,
                },
                status: 'GENERATED',
                createdAt: new Date(),
            });
        }
        // 2. Generate Threshold Candidates from Top Loss Drivers in Error Report
        for (const driver of inputs.errorReport.topLossDrivers) {
            if (driver.count >= 5) {
                let type = 'THRESHOLD';
                let change = {};
                let desc = '';
                if (driver.failureMode === 'HTF_CONFLICT') {
                    type = 'FILTER';
                    desc = `Strictly enforce Multi-Timeframe Trend alignment. Require MTF score >= 12/15.`;
                    change = { parameter: 'minMtfScore', value: 12 };
                }
                else if (driver.failureMode === 'VOLATILITY_MISREAD') {
                    type = 'VOLATILITY';
                    desc = `Apply 50% position sizing penalty or freeze entries during HIGH_VOLATILITY shocks.`;
                    change = { parameter: 'highVolatilitySizingMultiplier', value: 0.5 };
                }
                else if (driver.failureMode === 'STOP_TOO_TIGHT') {
                    type = 'EXIT';
                    desc = `Widen minimum structural stop buffer by 1.25x ATR to avoid premature whipsaws.`;
                    change = { parameter: 'stopLossAtrMultiplier', value: 1.25 };
                }
                else if (driver.failureMode === 'TARGET_TOO_FAR') {
                    type = 'EXIT';
                    desc = `Implement partial take-profit at 1.5R with immediate breakeven trailing.`;
                    change = { parameter: 'enablePartialTp1Trailing', value: true };
                }
                else {
                    desc = `Add candidate mitigation for failure mode ${driver.failureMode}.`;
                    change = { parameter: 'generalMitigation', mode: driver.failureMode };
                }
                candidates.push({
                    id: `cand-${Date.now()}-${this.candidateSeq++}`,
                    baseStrategyVersion: baseVersion,
                    candidateVersion: `${baseVersion}-cand-err-${this.candidateSeq}`,
                    type,
                    description: desc,
                    change,
                    evidence: {
                        sampleSize: driver.count,
                        expectancyBefore: driver.averageR,
                        expectancyAfterHistorical: driver.averageR, // Initialized to baseline prior to actual simulation
                    },
                    status: 'GENERATED',
                    createdAt: new Date(),
                });
            }
        }
        // 3. Generate Confluence Boosters from Positive Patterns
        const positivePatterns = inputs.patterns.filter((p) => p.type === 'POSITIVE_CONFLUENCE');
        for (const pat of positivePatterns) {
            candidates.push({
                id: `cand-${Date.now()}-${this.candidateSeq++}`,
                baseStrategyVersion: baseVersion,
                candidateVersion: `${baseVersion}-cand-pos-${this.candidateSeq}`,
                type: 'THRESHOLD',
                description: `Boost conviction & position size when high-confluence condition holds: [${pat.conditions.join(' AND ')}]`,
                change: {
                    action: 'BOOST_CONFIRMATION',
                    conditionRules: pat.conditions,
                    convictionMultiplier: 1.2,
                },
                evidence: {
                    sampleSize: pat.sampleSize,
                    expectancyBefore: pat.expectancy,
                    expectancyAfterHistorical: pat.expectancy, // Initialized to baseline prior to actual simulation
                    confidenceInterval: pat.confidenceInterval,
                    pValue: pat.pVal,
                },
                status: 'GENERATED',
                createdAt: new Date(),
            });
        }
        return candidates;
    }
}
exports.CandidateGenerator = CandidateGenerator;
//# sourceMappingURL=candidate-generator.js.map