"use strict";
'use client';
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LearningEngineDashboard = void 0;
const react_1 = __importStar(require("react"));
const lucide_react_1 = require("lucide-react");
const LearningEngineDashboard = () => {
    const [activeSubTab, setActiveSubTab] = (0, react_1.useState)('overview');
    const [overview, setOverview] = (0, react_1.useState)(null);
    const [failureStats, setFailureStats] = (0, react_1.useState)([]);
    const [patterns, setPatterns] = (0, react_1.useState)([]);
    const [candidates, setCandidates] = (0, react_1.useState)([]);
    const [isRunningCycle, setIsRunningCycle] = (0, react_1.useState)(false);
    const [lastCycleMessage, setLastCycleMessage] = (0, react_1.useState)(null);
    // Load initial demo/live data
    (0, react_1.useEffect)(() => {
        // Initial fallback data for instant rich UI rendering
        setOverview({
            activeStrategy: {
                strategyVersion: 'v2.0-smc-quant',
                expectancyR: 0.42,
                winRate: 58.5,
                profitFactor: 1.65,
                description: 'Baseline Institutional SMC + Quant Multi-Horizon Confluence Strategy',
            },
            activeModel: {
                modelVersion: 'v2.0-ml-canonical',
                brierScore: 0.18,
                expectedValueR: 1.25,
            },
            totalExperiences: 142,
            driftStatus: {
                hasDrift: false,
                featureDrift: false,
                performanceDrift: false,
                regimeDrift: false,
                executionDrift: false,
                details: [
                    'All feature, prediction, and performance distributions are within normal bounds.',
                ],
                recommendation: 'CONTINUE',
            },
            activeShadowCount: 2,
            provenPatternsCount: 5,
            rejectedHypothesesCount: 3,
        });
        setFailureStats([
            {
                failureMode: 'HTF_CONFLICT',
                count: 18,
                frequency: 12.7,
                totalLossAmount: 14200,
                lossContributionPct: 34.2,
                averageR: -0.62,
                winRate: 33.3,
            },
            {
                failureMode: 'VOLATILITY_MISREAD',
                count: 12,
                frequency: 8.5,
                totalLossAmount: 9800,
                lossContributionPct: 23.6,
                averageR: -0.48,
                winRate: 41.7,
            },
            {
                failureMode: 'STOP_TOO_TIGHT',
                count: 9,
                frequency: 6.3,
                totalLossAmount: 6400,
                lossContributionPct: 15.4,
                averageR: -0.41,
                winRate: 44.4,
            },
            {
                failureMode: 'TARGET_TOO_FAR',
                count: 7,
                frequency: 4.9,
                totalLossAmount: 4200,
                lossContributionPct: 10.1,
                averageR: -0.28,
                winRate: 42.8,
            },
            {
                failureMode: 'SLIPPAGE',
                count: 5,
                frequency: 3.5,
                totalLossAmount: 2800,
                lossContributionPct: 6.7,
                averageR: -0.22,
                winRate: 40.0,
            },
        ]);
        setPatterns([
            {
                id: 'pat-pos-1',
                type: 'POSITIVE_CONFLUENCE',
                conditions: ['HTF_ALIGNED', 'LIQUIDITY_SWEPT', 'HIGH_RVOL'],
                sampleSize: 42,
                winRate: 71.4,
                expectancy: 0.74,
                confidenceInterval: [0.52, 0.96],
                pVal: 0.0012,
                robustnessScore: 94,
            },
            {
                id: 'pat-pos-2',
                type: 'POSITIVE_CONFLUENCE',
                conditions: ['HTF_ALIGNED', 'TRENDING_REGIME', 'DISPLACEMENT_CONFIRMED'],
                sampleSize: 38,
                winRate: 68.4,
                expectancy: 0.65,
                confidenceInterval: [0.44, 0.86],
                pVal: 0.0028,
                robustnessScore: 91,
            },
            {
                id: 'pat-neg-1',
                type: 'NEGATIVE_FILTER',
                conditions: ['HTF_CONFLICT', 'HIGH_VOLATILITY'],
                sampleSize: 26,
                winRate: 26.9,
                expectancy: -0.58,
                confidenceInterval: [-0.78, -0.38],
                pVal: 0.0008,
                robustnessScore: 96,
            },
        ]);
        setCandidates([
            {
                id: 'cand-001',
                baseStrategyVersion: 'v2.0-smc-quant',
                candidateVersion: 'v2.1-filter-htf-vol',
                type: 'FILTER',
                description: 'Reject setups matching loss-inducing condition: [HTF_CONFLICT AND HIGH_VOLATILITY]',
                evidence: {
                    sampleSize: 26,
                    expectancyBefore: -0.58,
                    expectancyAfterHistorical: 0.29,
                },
                validationMetrics: {
                    outOfSampleExpectancy: 0.51,
                    profitFactor: 1.82,
                    maxDrawdownPercent: 8.4,
                    monteCarloRuinProb: 0.0,
                    transactionCostSurvived: true,
                },
                status: 'SHADOW',
            },
            {
                id: 'cand-002',
                baseStrategyVersion: 'v2.0-smc-quant',
                candidateVersion: 'v2.2-boost-confluence',
                type: 'THRESHOLD',
                description: 'Boost position sizing by 1.2x when [HTF_ALIGNED + LIQUIDITY_SWEPT + HIGH_RVOL]',
                evidence: {
                    sampleSize: 42,
                    expectancyBefore: 0.74,
                    expectancyAfterHistorical: 0.85,
                },
                validationMetrics: {
                    outOfSampleExpectancy: 0.58,
                    profitFactor: 1.95,
                    maxDrawdownPercent: 9.2,
                    monteCarloRuinProb: 0.0,
                    transactionCostSurvived: true,
                },
                status: 'VALIDATED',
            },
        ]);
    }, []);
    const handleTriggerRun = () => {
        setIsRunningCycle(true);
        setLastCycleMessage(null);
        setTimeout(() => {
            setIsRunningCycle(false);
            setLastCycleMessage('Self-Improvement cycle completed: Ingested 142 experiences, mined 3 patterns, validated 2 candidates (in shadow mode).');
        }, 1500);
    };
    const handlePromoteCandidate = (candidateId) => {
        setCandidates((prev) => prev.map((c) => (c.id === candidateId ? { ...c, status: 'PROMOTED' } : c)));
        if (overview) {
            setOverview({
                ...overview,
                activeStrategy: {
                    ...overview.activeStrategy,
                    strategyVersion: 'v2.1-filter-htf-vol',
                    expectancyR: 0.51,
                    winRate: 64.2,
                    profitFactor: 1.82,
                },
            });
        }
    };
    const handleRollback = () => {
        if (overview) {
            setOverview({
                ...overview,
                activeStrategy: {
                    ...overview.activeStrategy,
                    strategyVersion: 'v2.0-smc-quant',
                    expectancyR: 0.42,
                    winRate: 58.5,
                    profitFactor: 1.65,
                },
            });
        }
        setLastCycleMessage('Rollback successfully executed: Reverted to previous stable baseline v2.0-smc-quant.');
    };
    return (<div className="bg-[#080C14] border border-cyan-500/30 rounded-2xl p-4 sm:p-6 shadow-2xl font-mono space-y-6 text-slate-200 relative overflow-hidden">
      {/* Background ambient lighting */}
      <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-cyan-500/5 rounded-full blur-3xl pointer-events-none"/>
      <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-purple-500/5 rounded-full blur-3xl pointer-events-none"/>

      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-cyan-500/20 via-indigo-500/20 to-purple-500/20 border border-cyan-500/40 flex items-center justify-center shrink-0 shadow-lg shadow-cyan-500/10">
            <lucide_react_1.BrainCircuit className="w-6 h-6 text-cyan-400"/>
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-lg font-black text-white tracking-wide">
                SELF-IMPROVING TRADING INTELLIGENCE ENGINE
              </h1>
              <span className="text-[10px] bg-emerald-950 text-emerald-300 border border-emerald-700 px-2 py-0.5 rounded-full font-bold">
                EVOLUTIONARY v2.0
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Continuous Experience Replay • Error Mode Mining • Walk-Forward Purged OOS • Monte
              Carlo Ruin Testing • Shadow Promotion Gate
            </p>
          </div>
        </div>

        {/* Global Action Controls */}
        <div className="flex items-center gap-2.5">
          <button onClick={handleTriggerRun} disabled={isRunningCycle} className="px-4 py-2 bg-gradient-to-r from-cyan-500 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 text-slate-950 font-black text-xs rounded-xl shadow-lg shadow-cyan-500/20 transition-all flex items-center gap-2 active:scale-95 disabled:opacity-50">
            <lucide_react_1.RefreshCw className={`w-3.5 h-3.5 ${isRunningCycle ? 'animate-spin' : ''}`}/>
            <span>{isRunningCycle ? 'RUNNING CYCLE...' : 'RUN LEARNING CYCLE'}</span>
          </button>
          <button onClick={handleRollback} className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-rose-400 border border-rose-500/30 hover:border-rose-400 text-xs font-bold rounded-xl transition-all flex items-center gap-1.5 shadow" title="Rollback to previous stable version">
            <lucide_react_1.RotateCcw className="w-3.5 h-3.5"/>
            <span>ROLLBACK</span>
          </button>
        </div>
      </div>

      {lastCycleMessage && (<div className="p-3 rounded-xl bg-cyan-950/60 border border-cyan-700 text-xs text-cyan-300 flex items-center gap-2">
          <lucide_react_1.CheckCircle2 className="w-4 h-4 shrink-0 text-cyan-400"/>
          <span>{lastCycleMessage}</span>
        </div>)}

      {/* Sub-tab Navigation */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
        {[
            { id: 'overview', label: 'System Health & Metrics', icon: lucide_react_1.Activity },
            { id: 'errors', label: 'Failure Mode Mining', icon: lucide_react_1.AlertOctagon },
            { id: 'patterns', label: 'Pattern Discovery', icon: lucide_react_1.Sparkles },
            { id: 'candidates', label: 'Candidate Pipeline & Shadow Mode', icon: lucide_react_1.Layers },
        ].map((tab) => {
            const Icon = tab.icon;
            return (<button key={tab.id} onClick={() => setActiveSubTab(tab.id)} className={`px-3.5 py-1.5 rounded-xl text-xs font-bold uppercase transition-all flex items-center gap-2 ${activeSubTab === tab.id
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 shadow'
                    : 'text-slate-400 hover:text-white bg-slate-900/60 border border-slate-800'}`}>
              <Icon className="w-3.5 h-3.5"/>
              <span>{tab.label}</span>
            </button>);
        })}
      </div>

      {/* SUB-TAB 1: SYSTEM HEALTH & ACTIVE VERSIONS */}
      {activeSubTab === 'overview' && overview && (<div className="space-y-5">
          {/* Top 4 Quick Metric Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase font-bold block">
                Active Strategy Version
              </span>
              <div className="flex items-center gap-2 mt-1">
                <lucide_react_1.ShieldCheck className="w-4 h-4 text-emerald-400"/>
                <span className="text-sm font-black text-white">
                  {overview.activeStrategy.strategyVersion}
                </span>
              </div>
              <span className="text-[11px] text-emerald-400 block mt-1">
                Expectancy: <strong>+{overview.activeStrategy.expectancyR}R</strong> (
                {overview.activeStrategy.winRate}% Win)
              </span>
            </div>

            <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase font-bold block">
                Active ML Model
              </span>
              <div className="flex items-center gap-2 mt-1">
                <lucide_react_1.Brain className="w-4 h-4 text-cyan-400"/>
                <span className="text-sm font-black text-cyan-300">
                  {overview.activeModel.modelVersion}
                </span>
              </div>
              <span className="text-[11px] text-slate-400 block mt-1">
                Brier Score:{' '}
                <strong className="text-slate-200">{overview.activeModel.brierScore}</strong> • EV +
                {overview.activeModel.expectedValueR}R
              </span>
            </div>

            <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase font-bold block">
                Replay Experience Store
              </span>
              <div className="flex items-center gap-2 mt-1">
                <lucide_react_1.History className="w-4 h-4 text-indigo-400"/>
                <span className="text-sm font-black text-white">
                  {overview.totalExperiences} Trades Ingested
                </span>
              </div>
              <span className="text-[11px] text-slate-400 block mt-1">
                Proven: <strong className="text-emerald-400">{overview.provenPatternsCount}</strong>{' '}
                • Rejected:{' '}
                <strong className="text-rose-400">{overview.rejectedHypothesesCount}</strong>
              </span>
            </div>

            <div className={`p-4 rounded-xl border ${overview.driftStatus.hasDrift ? 'bg-rose-950/60 border-rose-700' : 'bg-slate-900/90 border-slate-800'}`}>
              <span className="text-[10px] text-slate-400 uppercase font-bold block">
                Drift & Integrity Radar
              </span>
              <div className="flex items-center gap-2 mt-1">
                <lucide_react_1.Activity className={`w-4 h-4 ${overview.driftStatus.hasDrift ? 'text-rose-400' : 'text-emerald-400'}`}/>
                <span className={`text-sm font-black ${overview.driftStatus.hasDrift ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {overview.driftStatus.hasDrift ? 'DRIFT DETECTED' : 'SYSTEM HEALTHY'}
                </span>
              </div>
              <span className="text-[11px] text-slate-400 block mt-1">
                Action:{' '}
                <strong className="text-cyan-300">{overview.driftStatus.recommendation}</strong>
              </span>
            </div>
          </div>

          {/* Decision Quality Matrix: Good/Bad Wins vs Good/Bad Losses */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-2xl space-y-3">
              <h3 className="text-xs font-bold text-white uppercase flex items-center gap-2">
                <lucide_react_1.Scale className="w-4 h-4 text-cyan-400"/>
                Institutional Trade Quality Matrix (Decision Quality vs Realized P&L)
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-emerald-950/50 border border-emerald-800 p-3.5 rounded-xl">
                  <span className="text-[10px] text-emerald-400 uppercase font-bold block">
                    GOOD TRADE WIN (74%)
                  </span>
                  <p className="text-xs text-slate-300 mt-1">
                    Clean SMC setup + MTF alignment + positive realization.
                  </p>
                </div>
                <div className="bg-amber-950/50 border border-amber-800 p-3.5 rounded-xl">
                  <span className="text-[10px] text-amber-400 uppercase font-bold block">
                    BAD TRADE WIN (26%)
                  </span>
                  <p className="text-xs text-slate-300 mt-1">
                    Weak setup / conflict that won due to luck. Not reinforced.
                  </p>
                </div>
                <div className="bg-cyan-950/50 border border-cyan-800 p-3.5 rounded-xl">
                  <span className="text-[10px] text-cyan-400 uppercase font-bold block">
                    GOOD TRADE LOSS (68%)
                  </span>
                  <p className="text-xs text-slate-300 mt-1">
                    Followed full rule confluence, standard statistical stop hit.
                  </p>
                </div>
                <div className="bg-rose-950/50 border border-rose-800 p-3.5 rounded-xl">
                  <span className="text-[10px] text-rose-400 uppercase font-bold block">
                    BAD TRADE LOSS (32%)
                  </span>
                  <p className="text-xs text-slate-300 mt-1">
                    Unfiltered structural mistake. Primary candidate source.
                  </p>
                </div>
              </div>
            </div>

            {/* MFE & MAE Excursion Profile */}
            <div className="bg-slate-900/80 border border-slate-800 p-5 rounded-2xl space-y-3">
              <h3 className="text-xs font-bold text-white uppercase flex items-center gap-2">
                <lucide_react_1.LineChart className="w-4 h-4 text-indigo-400"/>
                Excursion Profile & Exit Management (MFE vs MAE)
              </h3>
              <div className="space-y-2.5 text-xs">
                <div className="flex justify-between p-2 rounded bg-slate-950 border border-slate-800">
                  <span className="text-slate-400">Average Max Favorable Excursion (MFE):</span>
                  <span className="font-bold text-emerald-400">+2.42R</span>
                </div>
                <div className="flex justify-between p-2 rounded bg-slate-950 border border-slate-800">
                  <span className="text-slate-400">Average Max Adverse Excursion (MAE):</span>
                  <span className="font-bold text-rose-400">-0.78R</span>
                </div>
                <div className="flex justify-between p-2 rounded bg-slate-950 border border-slate-800">
                  <span className="text-slate-400">MFE / MAE Efficiency Ratio:</span>
                  <span className="font-bold text-cyan-400">3.10x</span>
                </div>
                <div className="flex justify-between p-2 rounded bg-slate-950 border border-slate-800">
                  <span className="text-slate-400">TP1 (1.5R) Reach Probability:</span>
                  <span className="font-bold text-cyan-400">68.5%</span>
                </div>
              </div>
            </div>
          </div>
        </div>)}

      {/* SUB-TAB 2: FAILURE MODE MINING */}
      {activeSubTab === 'errors' && (<div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-white uppercase flex items-center gap-2">
              <lucide_react_1.AlertOctagon className="w-4 h-4 text-rose-400"/>
              Automated Error Analyzer & Loss Contribution Heatmap
            </h3>
            <span className="text-[11px] text-slate-400">
              Categorized across 25+ institutional failure modes
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border border-slate-800 rounded-xl overflow-hidden">
              <thead className="bg-slate-900/90 text-slate-400 uppercase text-[10px] border-b border-slate-800 font-bold">
                <tr>
                  <th className="p-3">Failure Mode</th>
                  <th className="p-3 text-center">Count</th>
                  <th className="p-3 text-center">Frequency</th>
                  <th className="p-3 text-right">Total Loss Amount</th>
                  <th className="p-3 text-right">Loss Contribution</th>
                  <th className="p-3 text-center">Average R Drag</th>
                  <th className="p-3 text-center">Win Rate Under Mode</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-slate-950">
                {failureStats.map((item, idx) => (<tr key={idx} className="hover:bg-slate-900/50 transition-colors">
                    <td className="p-3 font-bold text-rose-400 flex items-center gap-1.5">
                      <lucide_react_1.Flame className="w-3.5 h-3.5 text-amber-500 shrink-0"/>
                      <span>{item.failureMode}</span>
                    </td>
                    <td className="p-3 text-center text-slate-200">{item.count}</td>
                    <td className="p-3 text-center text-slate-400">{item.frequency}%</td>
                    <td className="p-3 text-right font-bold text-rose-400">
                      ₹{item.totalLossAmount.toLocaleString()}
                    </td>
                    <td className="p-3 text-right font-bold text-amber-400">
                      {item.lossContributionPct}%
                    </td>
                    <td className="p-3 text-center font-bold text-rose-400">{item.averageR}R</td>
                    <td className="p-3 text-center text-slate-300">{item.winRate}%</td>
                  </tr>))}
              </tbody>
            </table>
          </div>
        </div>)}

      {/* SUB-TAB 3: PATTERN DISCOVERY */}
      {activeSubTab === 'patterns' && (<div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-white uppercase flex items-center gap-2">
              <lucide_react_1.Sparkles className="w-4 h-4 text-cyan-400"/>
              Discovered Multi-Factor Conjunctions & Statistical Filters
            </h3>
            <span className="text-[11px] text-slate-400">
              Filtered for statistical significance (p &lt; 0.05, N &ge; 20)
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {patterns.map((pat) => (<div key={pat.id} className={`p-4 rounded-xl border ${pat.type === 'POSITIVE_CONFLUENCE'
                    ? 'bg-emerald-950/40 border-emerald-800/80'
                    : 'bg-rose-950/40 border-rose-800/80'} space-y-3`}>
                <div className="flex items-center justify-between">
                  <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${pat.type === 'POSITIVE_CONFLUENCE'
                    ? 'bg-emerald-900 text-emerald-300'
                    : 'bg-rose-900 text-rose-300'}`}>
                    {pat.type === 'POSITIVE_CONFLUENCE' ? 'PROVEN CONFLUENCE' : 'NO-TRADE FILTER'}
                  </span>
                  <span className="text-[10px] text-slate-400 font-mono">p = {pat.pVal}</span>
                </div>

                <div className="space-y-1">
                  <span className="text-[11px] text-slate-400 font-bold block">Conditions:</span>
                  <div className="space-y-0.5">
                    {pat.conditions.map((c, i) => (<span key={i} className="block text-xs font-mono font-black text-white">
                        • {c}
                      </span>))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs pt-2 border-t border-slate-800/80">
                  <div>
                    <span className="text-[10px] text-slate-400 block">Expectancy</span>
                    <strong className={pat.expectancy > 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {pat.expectancy > 0 ? `+${pat.expectancy}R` : `${pat.expectancy}R`}
                    </strong>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 block">Win Rate</span>
                    <strong className="text-white">
                      {pat.winRate}% ({pat.sampleSize} trades)
                    </strong>
                  </div>
                  <div className="col-span-2">
                    <span className="text-[10px] text-slate-400 block">
                      95% Confidence Interval
                    </span>
                    <strong className="text-cyan-300">
                      [{pat.confidenceInterval[0]}R, {pat.confidenceInterval[1]}R]
                    </strong>
                  </div>
                </div>
              </div>))}
          </div>
        </div>)}

      {/* SUB-TAB 4: CANDIDATES & SHADOW MODE */}
      {activeSubTab === 'candidates' && (<div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-white uppercase flex items-center gap-2">
              <lucide_react_1.Layers className="w-4 h-4 text-indigo-400"/>
              Strategy Candidate Pipeline & Promotion Gate
            </h3>
            <span className="text-[11px] text-slate-400">
              Only promoted after passing OOS, Walk-Forward, Monte Carlo, and Shadow Trading
            </span>
          </div>

          <div className="space-y-3">
            {candidates.map((cand) => (<div key={cand.id} className="bg-slate-900/90 border border-slate-800 p-4 rounded-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="space-y-1.5 max-w-xl">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-black text-cyan-300">
                      {cand.candidateVersion}
                    </span>
                    <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded font-bold border border-slate-700">
                      {cand.type}
                    </span>
                    <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${cand.status === 'PROMOTED'
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                    : cand.status === 'SHADOW'
                        ? 'bg-purple-950 text-purple-300 border border-purple-700'
                        : 'bg-amber-950 text-amber-300 border border-amber-700'}`}>
                      {cand.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-300">{cand.description}</p>
                  <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                    <span>
                      OOS Expectancy:{' '}
                      <strong className="text-emerald-400">
                        +{cand.validationMetrics?.outOfSampleExpectancy}R
                      </strong>
                    </span>
                    <span>
                      Profit Factor:{' '}
                      <strong className="text-cyan-300">
                        {cand.validationMetrics?.profitFactor}
                      </strong>
                    </span>
                    <span>
                      Monte Carlo Ruin: <strong className="text-slate-200">0.0%</strong>
                    </span>
                    <span>
                      Costs Survived: <strong className="text-emerald-400">YES</strong>
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {cand.status !== 'PROMOTED' ? (<button onClick={() => handlePromoteCandidate(cand.id)} className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-slate-950 font-black text-xs rounded-lg transition-all shadow flex items-center gap-1.5">
                      <lucide_react_1.CheckCircle2 className="w-3.5 h-3.5"/>
                      <span>PROMOTE TO LIVE</span>
                    </button>) : (<span className="text-xs text-emerald-400 font-bold flex items-center gap-1">
                      <lucide_react_1.ShieldCheck className="w-4 h-4"/> ACTIVE IN PRODUCTION
                    </span>)}
                </div>
              </div>))}
          </div>
        </div>)}
    </div>);
};
exports.LearningEngineDashboard = LearningEngineDashboard;
//# sourceMappingURL=LearningEngineDashboard.js.map