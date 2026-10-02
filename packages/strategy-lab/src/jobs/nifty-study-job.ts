/**
 * NIFTY intraday study job (separate process so the search never blocks the API):
 * brings the cached NIFTY 15m history up to date, runs the intraday study and writes the result to --out.
 * Usage: node dist/jobs/nifty-study-job.js --data-dir <dir> --out <json file> [--model <json>]
 */
import * as fs from 'fs';
import { loadHistory, updateHistory } from '../history';
import { runNiftyStudy } from '../nifty-study';

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
  const bars = loadHistory(dataDir, 'NIFTY');
  if (bars.length < 1000) throw new Error(`only ${bars.length} NIFTY 15m bars`);
  // --model '{"delta":0.78,"thetaPerHour":1.9,"cost":4.2}': option model learned from live watch trades
  const model = arg('model') ? JSON.parse(arg('model')!) : undefined;
  const result = runNiftyStudy(bars, 15 * 60_000, { model });
  fs.writeFileSync(out, JSON.stringify({ history, result }));
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
