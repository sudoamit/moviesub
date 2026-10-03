/**
 * NIFTY intraday study job (separate process so the search never blocks the API):
 * brings the cached NIFTY 15m history up to date, runs the intraday study and writes the result to --out.
 * Usage: node dist/jobs/nifty-study-job.js --data-dir <dir> --out <json file> [--model <json>]
 */
import * as fs from 'fs';
import { assertDevelopmentOnly } from '../discovery';
import { DatasetStore } from '../dataset';
import { loadHistory, updateHistory } from '../history';
import { evaluateNiftyGolden, runNiftyStudy } from '../nifty-study';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const dataDir = arg('data-dir');
  const out = arg('out');
  if (!dataDir || !out) throw new Error('--data-dir and --out are required');
  let history: unknown;
  try {
    history = await updateHistory(dataDir, 'NIFTY');
  } catch (e: any) {
    history = { error: e.message }; // study the cached history
  }
  const history_ = loadHistory(dataDir, 'NIFTY');
  if (history_.length < 1000) throw new Error(`only ${history_.length} NIFTY 15m bars`);
  // DEVELOPMENT bars of the frozen NIFTY dataset version only; the golden holdout is read per passed candidate
  const ds = new DatasetStore(dataDir).open('NIFTY', history_, '15m');
  const bars = ds.developmentBars();
  assertDevelopmentOnly(bars, ds);
  // --model '{"delta":0.78,"thetaPerHour":1.9,"cost":4.2}': option model learned from live watch trades
  const model = arg('model') ? JSON.parse(arg('model')!) : undefined;
  const result: any = runNiftyStudy(bars, 15 * 60_000, { model });
  result.datasetVersion = ds.manifest.datasetVersion;
  result.passed = result.passed.map((c: any) => {
    try {
      const clearance = ds.clearForGolden(c.id, { developmentSearch: true, validationHoldOut: c.passed });
      const golden = evaluateNiftyGolden(c.genome, ds, clearance);
      return { ...c, golden, passed: golden.passed };
    } catch (e: any) {
      return { ...c, golden: { error: e.message }, passed: false };
    }
  }).filter((c: any) => c.passed);
  fs.writeFileSync(out, JSON.stringify({ history, result }));
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
