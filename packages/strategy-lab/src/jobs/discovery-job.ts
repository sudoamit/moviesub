/**
 * Discovery job (run as a separate process so the search never blocks the API):
 * 1. brings cached 15m history up to date;
 * 2. runs a discovery pass (search + cross-market confirmation);
 * 3. refreshes the full-history reference statistics of already-registered strategies.
 * Writes a JSON result to --out.
 * Usage: node dist/jobs/discovery-job.js --data-dir <dir> --existing <json file> --out <json file>
 */
import * as fs from 'fs';
import { discoverStrategies, DiscoveryTarget, referenceStats, LabTimeframe } from '../discovery';
import { loadHistory, updateHistory } from '../history';
import { StrategyGenome } from '../types';

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
  const datasets = Object.fromEntries(symbols.map((s) => [s, loadHistory(dataDir, s)]));

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
  const { candidates, runs } = discoverStrategies(datasets, targets, { existingIds: new Set(existing.map((e) => e.id)) });

  const refreshedReferences = existing
    .filter((e) => datasets[e.symbol]?.length)
    .map((e) => ({ id: e.id, reference: referenceStats(e.genome, datasets[e.symbol], e.symbol, e.timeframe) }));

  fs.writeFileSync(out, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), history, runs, candidates, refreshedReferences }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
