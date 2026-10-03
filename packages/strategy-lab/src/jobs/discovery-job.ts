/**
 * Discovery job (run as a separate process so the search never blocks the API):
 * 1. brings cached 15m history up to date;
 * 2. runs a discovery pass (search + cross-market confirmation) on DEVELOPMENT bars of frozen dataset versions;
 *    candidates that pass are evaluated once on the golden holdout and only golden passes are returned;
 * 3. refreshes the full-history reference statistics of already-registered strategies.
 * Writes a JSON result to --out.
 * Usage: node dist/jobs/discovery-job.js --data-dir <dir> --existing <json file> --out <json file>
 */
import * as fs from 'fs';
import {
  assertDevelopmentOnly, DEFAULT_DISCOVERY_OPTIONS, discoverStrategies, DiscoveryTarget, evaluateGolden, GOLDEN_CRITERIA,
  LabTimeframe, referenceStats,
} from '../discovery';
import { DatasetStore, ResearchDataset } from '../dataset';
import { loadHistory, updateHistory } from '../history';
import { DEFAULT_CRITERIA } from '../search';
import { Bar, StrategyGenome } from '../types';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const dataDir = arg('data-dir');
  const out = arg('out');
  if (!dataDir || !out) throw new Error('--data-dir and --out are required');
  const existing: Array<{ id: string; symbol: string; timeframe: LabTimeframe; genome: StrategyGenome }> =
    arg('existing') && fs.existsSync(arg('existing')!) ? JSON.parse(fs.readFileSync(arg('existing')!, 'utf8')) : [];
  const startedAt = new Date().toISOString();

  const symbols = [
    'BTCUSDT_PERP', 'ETHUSDT_PERP', 'SOLUSDT_PERP', 'BNBUSDT_PERP', 'ADAUSDT_PERP', 'LINKUSDT_PERP',
    // confirmation-only markets (not traded): more unseen siblings
    'XRPUSDT_PERP', 'DOGEUSDT_PERP', 'AVAXUSDT_PERP',
    'XAUUSD', 'NIFTY',
  ];
  const history: Record<string, unknown> = {};
  for (const sym of symbols) {
    try {
      history[sym] = await updateHistory(dataDir, sym);
    } catch (e: any) {
      history[sym] = { error: e.message };
    }
  }
  // Frozen dataset versions: discovery sees DEVELOPMENT bars only (train + validation); the golden holdout is
  // read once per candidate that passed every development gate.
  const store = new DatasetStore(dataDir);
  const researchSets: Record<string, ResearchDataset> = {};
  const datasets: Record<string, Bar[]> = {};
  const datasetInfo: Record<string, unknown> = {};
  for (const sym of symbols) {
    const hist = loadHistory(dataDir, sym);
    if (hist.length < 2000) { datasetInfo[sym] = { skipped: `only ${hist.length} bars` }; continue; }
    try {
      const ds = store.open(sym, hist, '15m');
      researchSets[sym] = ds;
      datasets[sym] = ds.developmentBars();
      assertDevelopmentOnly(datasets[sym], ds);
      const m = ds.manifest;
      datasetInfo[sym] = {
        datasetVersion: m.datasetVersion, development: [new Date(m.firstBarTime).toISOString(), new Date(m.goldenStart).toISOString()],
        validationFrom: new Date(m.validationStart).toISOString(), golden: [new Date(m.goldenStart).toISOString(), new Date(m.goldenEnd).toISOString()],
        developmentBars: m.developmentBars, goldenBars: m.goldenBars, goldenEvaluationsUsed: ds.goldenEvaluationsUsed(),
      };
    } catch (e: any) {
      datasetInfo[sym] = { error: e.message }; // fail closed: no research on a dataset that changed
    }
  }

  // Traded instruments only; ETH is a confirmation market for BTC.
  // Every traded perpetual is searched; a near-miss must be confirmed on a sibling market it was not searched on.
  const targets: DiscoveryTarget[] = [
    { symbol: 'BTCUSDT_PERP', timeframes: ['1h', '4h'], sibling: 'ETHUSDT_PERP' },
    { symbol: 'ETHUSDT_PERP', timeframes: ['1h', '4h'], sibling: 'BTCUSDT_PERP' },
    { symbol: 'SOLUSDT_PERP', timeframes: ['1h', '4h'], sibling: 'AVAXUSDT_PERP' },
    { symbol: 'BNBUSDT_PERP', timeframes: ['1h', '4h'], sibling: 'XRPUSDT_PERP' },
    { symbol: 'ADAUSDT_PERP', timeframes: ['1h', '4h'], sibling: 'DOGEUSDT_PERP' },
    { symbol: 'LINKUSDT_PERP', timeframes: ['1h', '4h'], sibling: 'AVAXUSDT_PERP' },
    { symbol: 'XAUUSD', timeframes: ['1h', '4h'] },
    // NIFTY is traded through options, which the lab runner cannot execute yet; its history keeps accumulating.
  ];
  const { candidates: developmentCandidates, runs } = discoverStrategies(datasets, targets, { existingIds: new Set(existing.map((e) => e.id)) });

  // Golden holdout gate: once per candidate, after every development gate passed
  const goldenEvaluations: Array<Record<string, unknown>> = [];
  const candidates = [];
  for (const c of developmentCandidates) {
    const ds = researchSets[c.symbol];
    const validationExpectancyR = Number((c.evidence as any)?.holdOut?.expectancyR ?? NaN);
    try {
      const clearance = ds.clearForGolden(c.id, {
        developmentSearch: true,
        [c.path === 'STRICT' ? 'validationHoldOut' : 'crossMarketConfirmation']: true,
      });
      const golden = evaluateGolden(c.genome, ds, clearance, c.symbol, c.timeframe, Number.isFinite(validationExpectancyR) ? validationExpectancyR : null);
      goldenEvaluations.push({ id: c.id, ...golden });
      if (golden.passed) candidates.push({ ...c, datasetVersion: ds.manifest.datasetVersion, golden });
    } catch (e: any) {
      goldenEvaluations.push({ id: c.id, error: e.message, passed: false });
    }
  }

  const refreshedReferences = existing
    .filter((e) => datasets[e.symbol]?.length)
    .map((e) => ({ id: e.id, reference: referenceStats(e.genome, datasets[e.symbol], e.symbol, e.timeframe) }));

  const searchConfig = { selectionCriteria: DEFAULT_CRITERIA, discoveryOptions: DEFAULT_DISCOVERY_OPTIONS, goldenCriteria: GOLDEN_CRITERIA };
  fs.writeFileSync(out, JSON.stringify({
    startedAt, finishedAt: new Date().toISOString(), history, datasets: datasetInfo, searchConfig, runs,
    developmentCandidates: developmentCandidates.map((c) => c.id), goldenEvaluations, candidates, refreshedReferences,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
