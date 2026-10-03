/**
 * Trade-quality training job (separate process). For each strategy: builds examples from its backtest trades on
 * its own market and sibling markets (DEVELOPMENT bars of the frozen dataset versions - never the golden
 * holdout) plus its closed shadow/live trades (features recorded at entry), validates walk-forward, and fits the
 * final model.
 * Usage: node dist/jobs/quality-job.js --data-dir <dir> --input <json> --out <json>
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import { QUALITY_FEATURE_VERSION } from '../versioning';
import { DatasetStore } from '../dataset';
import { loadHistory } from '../history';
import { buildQualityDataset, fitQualityModel, QUALITY_SIBLINGS, QualityExample, validateQualityModel } from '../quality';
import { StrategyGenome } from '../types';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface Input {
  strategies: Array<{
    id: string; symbol: string; timeframe: string; genome: StrategyGenome;
    closedTrades: Array<{ t: number; labelTime?: number; x: number[]; netR: number }>;
  }>;
}

function main() {
  const dataDir = arg('data-dir'), inputFile = arg('input'), out = arg('out');
  if (!dataDir || !inputFile || !out) throw new Error('--data-dir, --input and --out are required');
  const input: Input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const cache = new Map<string, any>();
  const store = new DatasetStore(dataDir);
  // DEVELOPMENT bars only: the golden holdout must never shape a model
  const history = (sym: string) => {
    if (!cache.has(sym)) {
      const hist = loadHistory(dataDir, sym);
      cache.set(sym, hist.length < 2000 ? [] : store.open(sym, hist, '15m').developmentBars());
    }
    return cache.get(sym);
  };

  const results = input.strategies.map((s) => {
    const markets: Record<string, any> = { [s.symbol]: history(s.symbol) };
    for (const sib of QUALITY_SIBLINGS[s.symbol] ?? []) markets[sib] = history(sib);
    const examples: QualityExample[] = buildQualityDataset(s.genome, s.timeframe, markets);
    const lastHistT = examples.length ? examples[examples.length - 1].t : 0;
    // Shadow / live trades after the cached history are new information; earlier ones duplicate backtest trades.
    for (const t of s.closedTrades) {
      if (t.t > lastHistT && Array.isArray(t.x)) examples.push({ t: t.t, labelTime: t.labelTime ?? t.t, market: `${s.symbol}:LAB`, x: t.x, y: Math.max(-1.5, Math.min(5, t.netR)) });
    }
    examples.sort((a, b) => a.t - b.t);
    const validation = validateQualityModel(examples, { primaryMarket: s.symbol });
    const model = fitQualityModel(examples);
    // Provenance: what the model was trained on and with which feature definitions
    const provenance = {
      featureVersion: QUALITY_FEATURE_VERSION,
      datasetVersions: Object.fromEntries(Object.keys(markets).map((m) => [m, store.manifest(m)?.datasetVersion ?? null])),
      markets: Object.keys(markets),
      trainingPeriod: examples.length ? { from: examples[0].t, to: Math.max(...examples.map((e) => e.labelTime ?? e.t)) } : null,
      examples: examples.length,
      modelVersion: `qm-${createHash('sha256').update(JSON.stringify(model.weights)).digest('hex').slice(0, 12)}`,
    };
    return {
      strategyId: s.id, examples: examples.length, labExamples: examples.filter((e) => e.market.endsWith(':LAB')).length,
      markets: Object.keys(markets), validation: { ...validation, provenance }, model: { ...model, provenance },
    };
  });
  fs.writeFileSync(out, JSON.stringify({ trainedAt: new Date().toISOString(), results }, null, 2));
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
