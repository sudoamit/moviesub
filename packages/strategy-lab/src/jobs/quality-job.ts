/**
 * Trade-quality training job (separate process). For each strategy: builds examples from its backtest trades on
 * its own market and sibling markets (full history) plus its closed shadow/live trades (features recorded at
 * entry), validates walk-forward, and fits the final model on everything.
 * Usage: node dist/jobs/quality-job.js --data-dir <dir> --input <json> --out <json>
 */
import * as fs from 'fs';
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
    closedTrades: Array<{ t: number; x: number[]; netR: number }>;
  }>;
}

function main() {
  const dataDir = arg('data-dir'), inputFile = arg('input'), out = arg('out');
  if (!dataDir || !inputFile || !out) throw new Error('--data-dir, --input and --out are required');
  const input: Input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const cache = new Map<string, any>();
  const history = (sym: string) => { if (!cache.has(sym)) cache.set(sym, loadHistory(dataDir, sym)); return cache.get(sym); };

  const results = input.strategies.map((s) => {
    const markets: Record<string, any> = { [s.symbol]: history(s.symbol) };
    for (const sib of QUALITY_SIBLINGS[s.symbol] ?? []) markets[sib] = history(sib);
    const examples: QualityExample[] = buildQualityDataset(s.genome, s.timeframe, markets);
    const lastHistT = examples.length ? examples[examples.length - 1].t : 0;
    // Shadow / live trades after the cached history are new information; earlier ones duplicate backtest trades.
    for (const t of s.closedTrades) {
      if (t.t > lastHistT && Array.isArray(t.x)) examples.push({ t: t.t, market: `${s.symbol}:LAB`, x: t.x, y: Math.max(-1.5, Math.min(5, t.netR)) });
    }
    examples.sort((a, b) => a.t - b.t);
    const validation = validateQualityModel(examples);
    const model = fitQualityModel(examples);
    return {
      strategyId: s.id, examples: examples.length, labExamples: examples.filter((e) => e.market.endsWith(':LAB')).length,
      markets: Object.keys(markets), validation, model,
    };
  });
  fs.writeFileSync(out, JSON.stringify({ trainedAt: new Date().toISOString(), results }, null, 2));
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
